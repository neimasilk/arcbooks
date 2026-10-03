package main

// ArcBooks Auto-Attest: a Chainlink CRE workflow that keeps a tamper-evident,
// hash-chained audit trail of an account's USDC activity on Arc.
//
// Every run (cron trigger):
//  1. EVM read  - latest block header, the attestor's last checkpoint for the account.
//  2. EVM read  - archive balances at the range edges and the USDC Transfer (EIP-7708
//                 system emitter) + Memo logs for the next contiguous block window(s).
//  3. Compute   - the canonical `arcbooks-statement-v1` CSV, byte-identical to the
//                 ArcBooks web app, and its keccak256 hash.
//  4. HTTP      - a USD/IDR reference rate from an external FX API, aggregated across
//                 the DON with median consensus (for IDR bookkeeping).
//  5. EVM write - a signed report to ArcBooksAttestor, which enforces chain continuity
//                 (fromBlock == previous toBlock + 1 and prevHash == previous hash).

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/shopspring/decimal"

	"github.com/smartcontractkit/chainlink-protos/cre/go/values/pb"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/blockchain/evm"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/blockchain/evm/bindings"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/networking/http"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/scheduler/cron"
	"github.com/smartcontractkit/cre-sdk-go/cre"
)

type Config struct {
	Schedule           string `json:"schedule"`
	ChainName          string `json:"chainName"`
	ChainID            uint64 `json:"chainId"`
	Account            string `json:"account"`
	AttestorAddress    string `json:"attestorAddress"`
	GasLimit           uint64 `json:"gasLimit"`
	WindowBlocks       uint64 `json:"windowBlocks"`       // <= 100 (CRE LogQueryBlockLimit)
	MaxWindows         uint64 `json:"maxWindows"`         // 3 windows * 3 queries + 4 reads <= 15 (ChainRead.CallLimit)
	ConfirmationBlocks uint64 `json:"confirmationBlocks"` // stay a few blocks behind head
	FxURL              string `json:"fxUrl"`
}

type FxRate struct {
	UsdIdr decimal.Decimal `consensus_aggregation:"median" json:"usdIdr"`
}

type RunResult struct {
	Status        string `json:"status"`
	Account       string `json:"account"`
	FromBlock     uint64 `json:"fromBlock,omitempty"`
	ToBlock       uint64 `json:"toBlock,omitempty"`
	Transfers     int    `json:"transfers"`
	StatementHash string `json:"statementHash,omitempty"`
	PrevHash      string `json:"prevHash,omitempty"`
	ClosingUSDC   string `json:"closingUsdc,omitempty"`
	UsdIdr        string `json:"usdIdr,omitempty"`
	TxHash        string `json:"txHash,omitempty"`
}

var headOfSelector = crypto.Keccak256([]byte("headOf(address)"))[:4]

func InitWorkflow(config *Config, logger *slog.Logger, secretsProvider cre.SecretsProvider) (cre.Workflow[*Config], error) {
	if config.WindowBlocks == 0 || config.WindowBlocks > 100 {
		return nil, fmt.Errorf("windowBlocks must be 1..100, got %d", config.WindowBlocks)
	}
	if config.MaxWindows == 0 || config.MaxWindows*3+4 > 15 {
		return nil, fmt.Errorf("maxWindows must keep EVM reads <= 15, got %d", config.MaxWindows)
	}
	if !common.IsHexAddress(config.Account) || !common.IsHexAddress(config.AttestorAddress) {
		return nil, errors.New("account and attestorAddress must be hex addresses")
	}
	return cre.Workflow[*Config]{
		cre.Handler(cron.Trigger(&cron.Config{Schedule: config.Schedule}), onCronTrigger),
	}, nil
}

func onCronTrigger(config *Config, runtime cre.Runtime, _ *cron.Payload) (string, error) {
	res, err := attest(config, runtime)
	if err != nil {
		runtime.Logger().Error("attestation failed", "err", err)
		return "", err
	}
	out, _ := json.Marshal(res)
	return string(out), nil
}

func bigOf(n uint64) *pb.BigInt { return pb.NewBigIntFromInt(new(big.Int).SetUint64(n)) }

func attest(config *Config, runtime cre.Runtime) (*RunResult, error) {
	logger := runtime.Logger()
	selector, err := evm.ChainSelectorFromName(config.ChainName)
	if err != nil {
		return nil, err
	}
	client := &evm.Client{ChainSelector: selector}
	account := common.HexToAddress(config.Account)
	attestor := common.HexToAddress(config.AttestorAddress)
	res := &RunResult{Account: strings.ToLower(account.Hex())}

	// 1. Chain head and the attestor's last checkpoint for this account.
	hdr, err := client.HeaderByNumber(runtime, &evm.HeaderByNumberRequest{BlockNumber: bindings.LatestBlockNumber}).Await()
	if err != nil {
		return nil, fmt.Errorf("header: %w", err)
	}
	latest := pb.NewIntFromBigInt(hdr.Header.BlockNumber).Uint64()
	safe := latest - config.ConfirmationBlocks

	call := append(append([]byte{}, headOfSelector...), common.LeftPadBytes(account.Bytes(), 32)...)
	headReply, err := client.CallContract(runtime, &evm.CallContractRequest{
		Call:        &evm.CallMsg{To: attestor.Bytes(), Data: call},
		BlockNumber: bindings.LatestBlockNumber,
	}).Await()
	if err != nil {
		return nil, fmt.Errorf("headOf: %w", err)
	}
	var prevHash [32]byte
	var prevTo, count uint64
	if d := headReply.Data; len(d) >= 96 {
		copy(prevHash[:], d[0:32])
		prevTo = new(big.Int).SetBytes(d[32:64]).Uint64()
		count = new(big.Int).SetBytes(d[64:96]).Uint64()
	}

	span := config.WindowBlocks * config.MaxWindows
	var from uint64
	if count == 0 {
		from = safe - span + 1 // genesis: start with the most recent full span
	} else {
		from = prevTo + 1
	}
	if from > safe {
		res.Status = "up-to-date"
		logger.Info("nothing to attest", "prevTo", prevTo, "safe", safe)
		return res, nil
	}
	to := from + span - 1
	if to > safe {
		to = safe
	}
	res.FromBlock, res.ToBlock = from, to
	logger.Info("attesting range", "account", res.Account, "from", from, "to", to, "checkpoint", count+1)

	// 2. Archive balances at the range edges.
	openRep, err := client.BalanceAt(runtime, &evm.BalanceAtRequest{Account: account.Bytes(), BlockNumber: bigOf(from - 1)}).Await()
	if err != nil {
		return nil, fmt.Errorf("opening balance: %w", err)
	}
	closeRep, err := client.BalanceAt(runtime, &evm.BalanceAtRequest{Account: account.Bytes(), BlockNumber: bigOf(to)}).Await()
	if err != nil {
		return nil, fmt.Errorf("closing balance: %w", err)
	}
	opening := pb.NewIntFromBigInt(openRep.Balance)
	closing := pb.NewIntFromBigInt(closeRep.Balance)

	// USDC Transfer logs (system emitter) out of / into the account, plus Memo events.
	acctTopic := common.LeftPadBytes(account.Bytes(), 32)
	var outLogs, inLogs, memoLogs []Log
	for start := from; start <= to; start += config.WindowBlocks {
		end := start + config.WindowBlocks - 1
		if end > to {
			end = to
		}
		q := func(addr []byte, topics ...[][]byte) ([]Log, error) {
			ts := make([]*evm.Topics, len(topics))
			for i, t := range topics {
				ts[i] = &evm.Topics{Topic: t}
			}
			rep, err := client.FilterLogs(runtime, &evm.FilterLogsRequest{FilterQuery: &evm.FilterQuery{
				FromBlock: bigOf(start), ToBlock: bigOf(end), Addresses: [][]byte{addr}, Topics: ts,
			}}).Await()
			if err != nil {
				return nil, err
			}
			out := make([]Log, 0, len(rep.Logs))
			for _, l := range rep.Logs {
				out = append(out, Log{Address: l.Address, Topics: l.Topics, TxHash: l.TxHash, Data: l.Data,
					BlockNumber: pb.NewIntFromBigInt(l.BlockNumber).Uint64(), Index: l.Index})
			}
			return out, nil
		}
		o, err := q(NativeEmitter, [][]byte{TransferTopic}, [][]byte{acctTopic})
		if err != nil {
			return nil, fmt.Errorf("out logs %d-%d: %w", start, end, err)
		}
		i, err := q(NativeEmitter, [][]byte{TransferTopic}, nil, [][]byte{acctTopic})
		if err != nil {
			return nil, fmt.Errorf("in logs %d-%d: %w", start, end, err)
		}
		m, err := q(MemoContract, [][]byte{MemoTopic})
		if err != nil {
			return nil, fmt.Errorf("memo logs %d-%d: %w", start, end, err)
		}
		outLogs, inLogs, memoLogs = append(outLogs, o...), append(inLogs, i...), append(memoLogs, m...)
	}

	// 3. Canonical statement (byte-identical to docs/statement.js) and its hash.
	csv, sum, _ := BuildStatement(config.ChainID, account.Bytes(), from, to, opening, closing, outLogs, inLogs, memoLogs)
	statementHash := crypto.Keccak256Hash([]byte(csv))
	res.Transfers = sum.Count
	res.StatementHash = statementHash.Hex()
	res.PrevHash = common.BytesToHash(prevHash[:]).Hex()
	res.ClosingUSDC = FormatUSDC(closing)
	logger.Info("statement built", "hash", res.StatementHash, "transfers", sum.Count,
		"in", FormatUSDC(sum.TotalIn), "out", FormatUSDC(sum.TotalOut), "fees", FormatUSDC(new(big.Int).Neg(sum.Unexplained)))

	// 4. External API: USD/IDR reference rate with DON median consensus.
	var rateE6 uint64
	fx, err := http.SendRequest(config, runtime, &http.Client{}, fetchFx, cre.ConsensusAggregationFromTags[*FxRate]()).Await()
	if err != nil {
		logger.Warn("fx rate unavailable, attesting without it", "err", err)
	} else {
		rateE6 = uint64(fx.UsdIdr.Mul(decimal.NewFromInt(1_000_000)).IntPart())
		res.UsdIdr = fx.UsdIdr.String()
		logger.Info("fx", "usdIdr", res.UsdIdr, "closingIdr", decimal.NewFromBigInt(closing, -18).Mul(fx.UsdIdr).StringFixed(0))
	}

	// 5. Signed report -> ArcBooksAttestor.onReport (via the CRE forwarder).
	payload, err := encodeReport(prevHash, statementHash, account, from, to, closing, sum.TotalIn, sum.TotalOut, uint32(sum.Count), rateE6)
	if err != nil {
		return nil, err
	}
	report, err := runtime.GenerateReport(&cre.ReportRequest{
		EncodedPayload: payload, EncoderName: "evm", SigningAlgo: "ecdsa", HashingAlgo: "keccak256",
	}).Await()
	if err != nil {
		return nil, fmt.Errorf("generate report: %w", err)
	}
	wr, err := client.WriteReport(runtime, &evm.WriteCreReportRequest{
		Receiver: attestor.Bytes(), Report: report, GasConfig: &evm.GasConfig{GasLimit: config.GasLimit},
	}).Await()
	if err != nil {
		return nil, fmt.Errorf("write report: %w", err)
	}
	if wr.TxStatus != evm.TxStatus_TX_STATUS_SUCCESS {
		msg := "unknown"
		if wr.ErrorMessage != nil {
			msg = *wr.ErrorMessage
		}
		return nil, fmt.Errorf("write tx status %v: %s", wr.TxStatus, msg)
	}
	if wr.ReceiverContractExecutionStatus != nil &&
		*wr.ReceiverContractExecutionStatus != evm.ReceiverContractExecutionStatus_RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS {
		return nil, errors.New("attestor rejected the report (broken chain or duplicate?)")
	}
	res.TxHash = common.BytesToHash(wr.TxHash).Hex()
	res.Status = "attested"
	logger.Info("checkpoint attested", "tx", res.TxHash, "hash", res.StatementHash)
	return res, nil
}

func fetchFx(config *Config, logger *slog.Logger, sr *http.SendRequester) (*FxRate, error) {
	resp, err := sr.SendRequest(&http.Request{Method: "GET", Url: config.FxURL}).Await()
	if err != nil {
		return nil, err
	}
	var body struct {
		Result string             `json:"result"`
		Rates  map[string]float64 `json:"rates"`
	}
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		return nil, fmt.Errorf("fx json: %w", err)
	}
	idr, ok := body.Rates["IDR"]
	if !ok || idr <= 0 {
		return nil, errors.New("fx response has no IDR rate")
	}
	return &FxRate{UsdIdr: decimal.NewFromFloat(idr).Round(6)}, nil
}

func encodeReport(prevHash [32]byte, statementHash common.Hash, account common.Address, from, to uint64,
	closing, totalIn, totalOut *big.Int, transfers uint32, rateE6 uint64) ([]byte, error) {
	ty := func(s string) abi.Type { t, _ := abi.NewType(s, "", nil); return t }
	args := abi.Arguments{
		{Type: ty("bytes32")}, {Type: ty("bytes32")}, {Type: ty("address")}, {Type: ty("uint64")}, {Type: ty("uint64")},
		{Type: ty("int256")}, {Type: ty("uint256")}, {Type: ty("uint256")}, {Type: ty("uint32")}, {Type: ty("uint64")},
	}
	return args.Pack(prevHash, [32]byte(statementHash), account, from, to, closing, totalIn, totalOut, transfers, rateE6)
}
