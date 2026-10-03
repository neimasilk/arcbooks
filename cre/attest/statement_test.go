package main

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"
)

type rpcLog struct {
	Address         string   `json:"address"`
	Topics          []string `json:"topics"`
	Data            string   `json:"data"`
	BlockNumber     string   `json:"blockNumber"`
	TransactionHash string   `json:"transactionHash"`
	LogIndex        string   `json:"logIndex"`
}

type fixture struct {
	ChainID   uint64   `json:"chainId"`
	Account   string   `json:"account"`
	FromBlock uint64   `json:"fromBlock"`
	ToBlock   uint64   `json:"toBlock"`
	Opening   string   `json:"opening"`
	Closing   string   `json:"closing"`
	OutLogs   []rpcLog `json:"outLogs"`
	InLogs    []rpcLog `json:"inLogs"`
	MemoLogs  []rpcLog `json:"memoLogs"`
}

func hexBytes(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

func hexBig(s string) *big.Int {
	v, _ := new(big.Int).SetString(strings.TrimPrefix(s, "0x"), 16)
	if v == nil {
		return new(big.Int)
	}
	return v
}

func convert(t *testing.T, in []rpcLog) []Log {
	out := make([]Log, 0, len(in))
	for _, l := range in {
		topics := make([][]byte, len(l.Topics))
		for i, tp := range l.Topics {
			topics[i] = hexBytes(t, tp)
		}
		out = append(out, Log{
			Address: hexBytes(t, l.Address), Topics: topics, TxHash: hexBytes(t, l.TransactionHash),
			Data: hexBytes(t, l.Data), BlockNumber: hexBig(l.BlockNumber).Uint64(), Index: uint32(hexBig(l.LogIndex).Uint64()),
		})
	}
	return out
}

// TestMatchesJavaScript checks that the Go port produces byte-identical canonical CSVs
// to docs/statement.js for real Arc mainnet and testnet data (fixtures from test/make-cre-fixture.mjs).
func TestMatchesJavaScript(t *testing.T) {
	for _, name := range []string{"testnet1", "mainnet-demo", "mainnet-busy"} {
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile("testdata/" + name + ".json")
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile("testdata/" + name + ".csv")
			if err != nil {
				t.Fatal(err)
			}
			var f fixture
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatal(err)
			}
			got, sum, _ := BuildStatement(f.ChainID, hexBytes(t, f.Account), f.FromBlock, f.ToBlock,
				hexBig(f.Opening), hexBig(f.Closing), convert(t, f.OutLogs), convert(t, f.InLogs), convert(t, f.MemoLogs))
			if got != string(want) {
				gl, wl := strings.Split(got, "\n"), strings.Split(string(want), "\n")
				for i := 0; i < len(gl) && i < len(wl); i++ {
					if gl[i] != wl[i] {
						t.Fatalf("line %d differs:\n go: %q\n js: %q", i+1, gl[i], wl[i])
					}
				}
				t.Fatalf("length differs: go %d lines, js %d lines", len(gl), len(wl))
			}
			t.Logf("%s: %d transfers, byte-identical (%d bytes)", name, sum.Count, len(got))
		})
	}
}

func TestFormatUSDC(t *testing.T) {
	cases := map[string]string{"0": "0", "1": "0.000000000000000001", "1500000000000000000": "1.5", "-2000000000000000000": "-2"}
	for in, want := range cases {
		v, _ := new(big.Int).SetString(in, 10)
		if got := FormatUSDC(v); got != want {
			t.Errorf("FormatUSDC(%s) = %s, want %s", in, got, want)
		}
	}
}

func TestMemoToText(t *testing.T) {
	if got := MemoToText([]byte("INV-1 Kopi")); got != "INV-1 Kopi" {
		t.Errorf("plain: %q", got)
	}
	if got := MemoToText([]byte{0x01, 0x02}); got != "0x0102" {
		t.Errorf("control chars should be hex: %q", got)
	}
	if got := MemoToText([]byte{0xff}); got != "0xff" {
		t.Errorf("invalid utf8 should be hex: %q", got)
	}
	if got := MemoToText(nil); got != "" {
		t.Errorf("empty: %q", got)
	}
}
