package main

// Go port of docs/statement.js (canonical "arcbooks-statement-v1").
// The output MUST be byte-identical to the JavaScript implementation so that a
// statement attested by the CRE workflow can be re-derived and verified in the
// ArcBooks web app. statement_test.go checks this against fixtures produced by JS.

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"unicode/utf8"
)

const StatementVersion = "arcbooks-statement-v1"

var (
	// Native USDC system emitter (EIP-7708 Transfer logs, 18 decimals).
	NativeEmitter = mustHex("fffffffffffffffffffffffffffffffffffffffe")
	// Predeployed Memo contract.
	MemoContract = mustHex("5294e9927c3306dcbadb03fe70b92e01ccede505")
	// keccak256("Transfer(address,address,uint256)")
	TransferTopic = mustHex("ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
	// keccak256("Memo(address,address,bytes32,bytes32,bytes,uint256)")
	MemoTopic = mustHex("eb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4")

	weiPerUSDC = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
)

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// Log is the subset of an EVM log the statement needs.
type Log struct {
	Address     []byte
	Topics      [][]byte
	TxHash      []byte
	Data        []byte
	BlockNumber uint64
	Index       uint32
}

type Row struct {
	Block        uint64
	TxHash       string
	LogIndex     uint32
	Direction    string // "in" | "out"
	Counterparty string
	AmountWei    *big.Int
	MemoID       string
	Memo         string
}

type Summary struct {
	ChainID     uint64
	Account     string
	FromBlock   uint64
	ToBlock     uint64
	Opening     *big.Int
	Closing     *big.Int
	TotalIn     *big.Int
	TotalOut    *big.Int
	Unexplained *big.Int // closing - opening - in + out (<= 0: gas fees and non-logged movement)
	Count       int
}

// FormatUSDC renders an 18-decimal wei amount as an exact decimal string (no trailing zeros).
func FormatUSDC(wei *big.Int) string {
	v := new(big.Int).Set(wei)
	neg := v.Sign() < 0
	if neg {
		v.Neg(v)
	}
	whole, frac := new(big.Int).QuoRem(v, weiPerUSDC, new(big.Int))
	fs := fmt.Sprintf("%018s", frac.String())
	fs = strings.TrimRight(fs, "0")
	out := whole.String()
	if fs != "" {
		out += "." + fs
	}
	if neg {
		out = "-" + out
	}
	return out
}

func hex0x(b []byte) string { return "0x" + hex.EncodeToString(b) }

func addrFromTopic(t []byte) string {
	if len(t) < 20 {
		return hex0x(t)
	}
	return hex0x(t[len(t)-20:])
}

// decodeMemoData decodes the non-indexed Memo event data: (bytes32 callDataHash, bytes memo, uint256 memoIndex).
func decodeMemoData(data []byte) (memo []byte, memoIndex *big.Int) {
	word := func(i int) []byte {
		start := i * 32
		if start+32 > len(data) {
			return make([]byte, 32)
		}
		return data[start : start+32]
	}
	offset := int(new(big.Int).SetBytes(word(1)).Uint64() / 32)
	memoIndex = new(big.Int).SetBytes(word(2))
	length := int(new(big.Int).SetBytes(word(offset)).Uint64())
	start := (offset + 1) * 32
	end := start + length
	if start > len(data) {
		return nil, memoIndex
	}
	if end > len(data) {
		end = len(data)
	}
	return data[start:end], memoIndex
}

// MemoToText mirrors the JS logic: strict UTF-8 decode (BOM stripped like TextDecoder),
// accepted only if every char is printable (U+0020..U+007E or >= U+00A0); otherwise 0x-hex.
func MemoToText(memo []byte) string {
	if len(memo) == 0 {
		return ""
	}
	if utf8.Valid(memo) {
		s := string(bytes.TrimPrefix(memo, []byte{0xEF, 0xBB, 0xBF}))
		ok := true
		for _, r := range s {
			if !((r >= 0x20 && r <= 0x7E) || r >= 0xA0) {
				ok = false
				break
			}
		}
		if ok {
			return s
		}
	}
	return hex0x(memo)
}

func csvCell(s string) string {
	if strings.ContainsAny(s, "\",\n\r") {
		return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
	}
	return s
}

type memoEntry struct {
	id    string
	text  string
	index *big.Int
}

// BuildStatement assembles rows and the canonical CSV for [fromBlock, toBlock].
// outLogs/inLogs are system-emitter Transfer logs filtered by topic1/topic2 = account;
// memoLogs are Memo events from the Memo contract over the same range.
func BuildStatement(chainID uint64, account []byte, fromBlock, toBlock uint64, opening, closing *big.Int,
	outLogs, inLogs, memoLogs []Log) (string, Summary, []Row) {

	acct := hex0x(account)
	memosByTx := map[string][]memoEntry{}
	for _, l := range memoLogs {
		if len(l.Topics) < 4 {
			continue
		}
		m, idx := decodeMemoData(l.Data)
		k := hex0x(l.TxHash)
		memosByTx[k] = append(memosByTx[k], memoEntry{id: hex0x(l.Topics[3]), text: MemoToText(m), index: idx})
	}

	var rows []Row
	seen := map[string]bool{}
	add := func(logs []Log, dir string) {
		for _, l := range logs {
			if !bytes.Equal(l.Address, NativeEmitter) || len(l.Topics) < 3 || !bytes.Equal(l.Topics[0], TransferTopic) {
				continue
			}
			key := fmt.Sprintf("%s:%d:%s", hex0x(l.TxHash), l.Index, dir)
			if seen[key] {
				continue
			}
			seen[key] = true
			cp := addrFromTopic(l.Topics[2])
			if dir == "in" {
				cp = addrFromTopic(l.Topics[1])
			}
			rows = append(rows, Row{
				Block: l.BlockNumber, TxHash: hex0x(l.TxHash), LogIndex: l.Index, Direction: dir,
				Counterparty: cp, AmountWei: new(big.Int).SetBytes(l.Data),
			})
		}
	}
	add(outLogs, "out")
	add(inLogs, "in")

	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.Block != b.Block {
			return a.Block < b.Block
		}
		if a.LogIndex != b.LogIndex {
			return a.LogIndex < b.LogIndex
		}
		return a.Direction < b.Direction
	})

	totalIn, totalOut := new(big.Int), new(big.Int)
	for i := range rows {
		ms := memosByTx[rows[i].TxHash]
		sort.SliceStable(ms, func(a, b int) bool { return ms[a].index.Cmp(ms[b].index) < 0 })
		ids, texts := make([]string, len(ms)), make([]string, len(ms))
		for k, m := range ms {
			ids[k], texts[k] = m.id, m.text
		}
		rows[i].MemoID = strings.Join(ids, "|")
		rows[i].Memo = strings.Join(texts, "|")
		if rows[i].Direction == "in" {
			totalIn.Add(totalIn, rows[i].AmountWei)
		} else {
			totalOut.Add(totalOut, rows[i].AmountWei)
		}
	}

	unexplained := new(big.Int).Sub(closing, opening)
	unexplained.Sub(unexplained, totalIn)
	unexplained.Add(unexplained, totalOut)

	sum := Summary{ChainID: chainID, Account: acct, FromBlock: fromBlock, ToBlock: toBlock,
		Opening: opening, Closing: closing, TotalIn: totalIn, TotalOut: totalOut, Unexplained: unexplained, Count: len(rows)}
	return CanonicalCSV(sum, rows), sum, rows
}

func CanonicalCSV(s Summary, rows []Row) string {
	var b strings.Builder
	line := func(f string, a ...any) { b.WriteString(fmt.Sprintf(f, a...)); b.WriteByte('\n') }
	line("# %s", StatementVersion)
	line("# chain_id,%d", s.ChainID)
	line("# account,%s", s.Account)
	line("# from_block,%d", s.FromBlock)
	line("# to_block,%d", s.ToBlock)
	line("# opening_balance_usdc,%s", FormatUSDC(s.Opening))
	line("# closing_balance_usdc,%s", FormatUSDC(s.Closing))
	line("# total_in_usdc,%s", FormatUSDC(s.TotalIn))
	line("# total_out_usdc,%s", FormatUSDC(s.TotalOut))
	line("# fees_and_unlogged_usdc,%s", FormatUSDC(new(big.Int).Neg(s.Unexplained)))
	line("# transfers,%d", s.Count)
	line("block,tx_hash,log_index,direction,counterparty,amount_usdc,memo_id,memo")
	for _, r := range rows {
		cells := []string{
			fmt.Sprint(r.Block), r.TxHash, fmt.Sprint(r.LogIndex), r.Direction, r.Counterparty,
			FormatUSDC(r.AmountWei), r.MemoID, r.Memo,
		}
		for i := range cells {
			cells[i] = csvCell(cells[i])
		}
		line("%s", strings.Join(cells, ","))
	}
	return b.String()
}
