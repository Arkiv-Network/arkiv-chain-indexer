import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchBlockInspect,
  fetchLatestBlockInspect,
  type BlockInspectResponse,
  type InspectedTransaction,
} from "./api";
import { fmtBytes, fmtDate, fmtGasPrice, fmtInteger, fmtRatio, fmtTokenAmount } from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { buildPermalinkHref, writePermalink } from "./permalinks";
import { AddressCell } from "./TransactionsView";
import { TransactionHashLink } from "./TransactionView";
import { renderTableHeader } from "./tableHeader";
import { OpBadgeList } from "@/components/op-badge";
import { Stat, StatGrid } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface BlockViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
  noBatcher: boolean;
}

interface Column {
  key: string;
  label: string;
  className?: string;
  render: (row: InspectedTransaction) => ReactNode;
}

const EMPTY_BLOCK = "";

export function BlockView({ locationSearch, onLocationChange, timeZone, tokenSymbol, noBatcher }: BlockViewProps) {
  const [blockNumber, setBlockNumber] = useState(() => readBlockFromSearch(locationSearch));
  const [appliedBlockNumber, setAppliedBlockNumber] = useState(blockNumber);
  const [data, setData] = useState<BlockInspectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The mount effect always starts a load, so the very first paint must
  // already show the loading layout: painting the idle state for one frame
  // and then swapping in the pill and skeleton was a guaranteed layout shift.
  const [loading, setLoading] = useState(true);
  const [copyStatus, setCopyStatus] = useState("");
  const loadRequestId = useRef(0);

  const load = useCallback((value: string) => {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    const trimmed = value.trim();
    setLoading(true);
    setError(null);
    const request = trimmed ? fetchBlockInspect(trimmed) : fetchLatestBlockInspect();
    request
      .then((body) => {
        if (requestId !== loadRequestId.current) return;
        setData(body);
        if (!trimmed) {
          setBlockNumber((current) => (current.trim() ? current : body.block.blockNumberDecimal));
        }
      })
      .catch((err: Error) => {
        if (requestId !== loadRequestId.current) return;
        setData(null);
        setError(err.message);
      })
      .finally(() => {
        if (requestId === loadRequestId.current) {
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    load(appliedBlockNumber);
  }, [appliedBlockNumber, load]);

  useEffect(() => {
    const next = readBlockFromSearch(locationSearch);
    setBlockNumber(next);
    setAppliedBlockNumber(next);
    setCopyStatus("");
  }, [locationSearch]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = blockNumber.trim();
    if (writePermalink("block", { block: next })) {
      onLocationChange();
    } else {
      setAppliedBlockNumber(next);
    }
  };

  const copyPermalink = async () => {
    const href = buildPermalinkHref("block", { block: displayedBlockNumber });
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(href);
    }
  };

  const block = data?.block;
  // Show the requested number already while loading: the status label and the
  // adjacent-block buttons then keep the exact same width when the response
  // lands, instead of shifting the lookup panel.
  const displayedBlockNumber = block?.blockNumberDecimal ?? appliedBlockNumber;
  const adjacentBlocks = useMemo(() => adjacentBlockNumbers(displayedBlockNumber), [displayedBlockNumber]);
  const columns = useMemo(
    () => transactionColumns(tokenSymbol, onLocationChange),
    [tokenSymbol, onLocationChange],
  );

  const navigateToBlock = (nextBlock: string) => {
    setCopyStatus("");
    setBlockNumber(nextBlock);
    if (writePermalink("block", { block: nextBlock })) {
      onLocationChange();
    } else {
      setAppliedBlockNumber(nextBlock);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 py-6 md:px-6">
      <PageBreadcrumbs
        items={[
          { view: "home", label: "Home" },
          { view: "blocks", label: "Block list" },
          { view: "block", label: "Block details" },
        ]}
        onLocationChange={onLocationChange}
      />
      <h2 className="font-heading text-lg font-black tracking-tight">Block info</h2>

      <div className="flex flex-col gap-3 border border-border bg-card p-3">
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="block-number-input" className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              Block number
            </Label>
            <div className="flex items-center">
              <span
                className="flex h-8 items-center border border-r-0 border-input bg-muted px-2 font-mono text-xs text-muted-foreground"
                aria-hidden="true"
              >
                #
              </span>
              <Input
                id="block-number-input"
                type="text"
                inputMode="numeric"
                placeholder="e.g. 29668"
                className="w-40 rounded-none"
                value={blockNumber}
                onChange={(event) => setBlockNumber(event.target.value)}
              />
            </div>
          </div>
          <Button type="submit" size="sm" disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {loading ? "Loading…" : "Load"}
          </Button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={cn("flex flex-wrap items-center gap-2 text-xs", error && "text-destructive")}>
            <span className="text-foreground">
              Block <strong className="font-mono">{displayedBlockNumber.trim() || "—"}</strong>
            </span>
            {loading ? (
              <span className="text-muted-foreground">Loading…</span>
            ) : error ? (
              <span className="text-destructive">Failed to load block: {error}</span>
            ) : block ? (
              <span className="text-muted-foreground">{block.transactionCount} txns</span>
            ) : (
              <span className="text-muted-foreground">Enter a block number to inspect stored block details.</span>
            )}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1" aria-label="Adjacent blocks">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => adjacentBlocks.previous && navigateToBlock(adjacentBlocks.previous)}
                disabled={loading || !adjacentBlocks.previous}
                aria-label="Previous block"
                title="Previous block"
              >
                <ChevronLeft className="size-3.5" />
                {adjacentBlocks.previous ?? "Prev"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => adjacentBlocks.next && navigateToBlock(adjacentBlocks.next)}
                disabled={loading || !adjacentBlocks.next}
                aria-label="Next block"
                title="Next block"
              >
                {adjacentBlocks.next ?? "Next"}
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={copyPermalink} disabled={!displayedBlockNumber.trim()}>
              Copy link
            </Button>
            {copyStatus ? <span className="text-xs text-muted-foreground">{copyStatus}</span> : null}
          </div>
        </div>
      </div>

      {block ? (
        <>
          <StatGrid>
            <Stat label="Block">{block.blockNumberDecimal}</Stat>
            <Stat label="Date">{fmtDate(block.blockDate, timeZone)}</Stat>
            <Stat label="Block time">{`${fmtInteger(block.blockTimeSeconds)}s`}</Stat>
            <Stat label="Transactions">{fmtInteger(block.transactionCount)}</Stat>
            <Stat label="Base fee">{fmtGasPrice(block.baseBlockFeeWei)}</Stat>
            <Stat label="Gas used / limit">{fmtRatio(block.totalGasUsed, block.maxGasInBlock)}</Stat>
            <Stat label="Input data">{fmtBytes(block.totalInputDataSizeBytes)}</Stat>
            <Stat label="Input data zstd">{fmtBytes(block.totalInputDataCompressedSizeBytes)}</Stat>
            <Stat label="Block reward">{fmtTokenAmount(block.blockRewardWei, tokenSymbol)}</Stat>
            <Stat label="Burnt fees">{fmtTokenAmount(block.burntFeesWei, tokenSymbol)}</Stat>
            <Stat label="Total tx fees">{fmtTokenAmount(block.totalTransactionFeeWei, tokenSymbol)}</Stat>
            <Stat label="Avg fee price">{fmtGasPrice(block.averageFeePriceWei)}</Stat>
            <Stat label="Avg tx fee">{fmtTokenAmount(block.averageTransactionFeeWei, tokenSymbol)}</Stat>
            <Stat label="Avg tx gas">{fmtInteger(block.averageTransactionGasUsed)}</Stat>
            <Stat label="Avg tx input data">{fmtBytes(block.averageTransactionInputDataSizeBytes)}</Stat>
            <Stat label="Avg tx input zstd">{fmtBytes(block.averageTransactionInputDataCompressedSizeBytes)}</Stat>
            <Stat label="Avg priority fee">{fmtGasPrice(block.averagePriorityFeeWei)}</Stat>
            <Stat label="Gas-weighted priority">{fmtGasPrice(block.averagePriorityFeeWeightedWei)}</Stat>
            {noBatcher ? null : (
              <>
                <Stat label="Batcher queue">{fmtInteger(block.batcherQueueSize)}</Stat>
                <Stat label="Batcher intensity">{fmtInteger(block.batcherIntensity)}</Stat>
                <Stat label="Batcher lower">{fmtInteger(block.batcherLowerThreshold)}</Stat>
                <Stat label="Batcher upper">{fmtInteger(block.batcherUpperThreshold)}</Stat>
                <Stat label="Batcher max block">{fmtInteger(block.batcherMaxBlockSize)}</Stat>
                <Stat label="Batcher max tx">{fmtInteger(block.batcherMaxTxSize)}</Stat>
              </>
            )}
          </StatGrid>

          {data.transactionLoadError ? (
            <p className="text-xs text-destructive">Transactions unavailable: {data.transactionLoadError}</p>
          ) : null}

          <div className="overflow-x-auto border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {columns.map((column) => (
                    <TableHead key={column.key} className={column.className}>
                      {renderTableHeader(column.label)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {block.transactions.map((row) => (
                  <TableRow key={`${row.position}:${row.hash}`}>
                    {columns.map((column) => (
                      <TableCell key={column.key} className={column.className} data-label={column.label}>
                        {column.render(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      ) : loading ? (
        <BlockDetailSkeleton rows={noBatcher ? 18 : 24} />
      ) : null}
    </section>
  );
}

/**
 * Placeholder matching the loaded layout (summary grid plus transactions
 * table) so the first data render replaces it in place instead of pushing
 * everything below the lookup panel down.
 */
function BlockDetailSkeleton({ rows }: { rows: number }) {
  return (
    <div role="status" aria-label="Loading block details">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="border border-border bg-muted/40 px-3 py-2">
            <div className="h-2.5 w-16 animate-pulse rounded-none bg-muted-foreground/20" />
            <div className="mt-2 h-3 w-20 animate-pulse rounded-none bg-muted-foreground/20" />
          </div>
        ))}
      </div>
      <div className="mt-4 h-48 animate-pulse border border-border bg-muted/40" aria-hidden="true" />
    </div>
  );
}

function transactionColumns(tokenSymbol: string, onLocationChange: () => void): Column[] {
  return [
    {
      key: "position",
      label: "Pos",
      className: "text-right font-mono tabular-nums",
      render: (row) => row.position,
    },
    {
      key: "hash",
      label: "Hash",
      render: (row) => <TransactionHashLink hash={row.hash} onLocationChange={onLocationChange} />,
    },
    {
      key: "arkivOps",
      label: "Arkiv ops",
      render: (row) => <OpBadgeList operations={row.operationsSummary} />,
    },
    {
      key: "from",
      label: "From",
      render: (row) => <AddressCell address={row.from} />,
    },
    {
      key: "nonce",
      label: "Nonce",
      className: "text-right font-mono tabular-nums",
      render: (row) => row.nonce ?? "-",
    },
    {
      key: "gasUsed",
      label: "Gas (used / limit)",
      className: "text-right font-mono tabular-nums",
      render: (row) => `${fmtInteger(row.gasUsed)} / ${fmtInteger(row.gasLimit)}`,
    },
    {
      key: "inputDataSizeBytes",
      label: "Input data",
      className: "text-right font-mono tabular-nums",
      render: (row) => fmtBytes(row.inputDataSizeBytes),
    },
    {
      key: "inputDataCompressedSizeBytes",
      label: "Input zstd",
      className: "text-right font-mono tabular-nums",
      render: (row) => fmtBytes(row.inputDataCompressedSizeBytes),
    },
    {
      key: "effectiveGasPriceWei",
      label: "Effective fee",
      className: "text-right font-mono tabular-nums",
      render: (row) => fmtGasPrice(row.effectiveGasPriceWei),
    },
    {
      key: "transactionFeeWei",
      label: "Tx fee",
      className: "text-right font-mono tabular-nums",
      render: (row) => fmtTokenAmount(row.transactionFeeWei, tokenSymbol),
    },
  ];
}

function readBlockFromSearch(search: string): string {
  const value = new URLSearchParams(search).get("block");
  return value?.trim() ?? EMPTY_BLOCK;
}

export function adjacentBlockNumbers(value: string): { previous: string | null; next: string | null } {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { previous: null, next: null };

  const current = BigInt(trimmed);
  return {
    previous: current > 0n ? String(current - 1n) : null,
    next: String(current + 1n),
  };
}
