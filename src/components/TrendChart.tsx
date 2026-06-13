import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * High-contrast trend visuals on pure black. Lines are NEUTRAL white — a trend
 * line is not a delta metric, so it never uses green/red/blue (those are
 * reserved: green/red for deltas, blue for AI). Grid and axes use the card
 * border / label greys.
 */

export interface Point {
  label: string;
  value: number | null;
}

const GRID = "#222222";
const LABEL = "#666666";
const LINE = "#ffffff";

// recharts v3 passes a loosely-typed props bag to a custom content function;
// we read only active/label/payload, so a minimal local shape keeps it typed
// without fighting the library generics.
interface TooltipBag {
  active?: boolean;
  label?: string | number;
  payload?: { value?: number | string | null }[];
}

function renderTooltip(formatValue?: (v: number) => string) {
  return ({ active, label, payload }: TooltipBag) => {
    const v = payload?.[0]?.value;
    if (!active || v == null || typeof v !== "number") return null;
    return (
      <div className="rounded-[8px] border border-card-border bg-card px-3 py-2">
        <p className="label mb-0.5">{label}</p>
        <p className="text-sm font-bold text-white">{formatValue ? formatValue(v) : v}</p>
      </div>
    );
  };
}

export function TrendChart({
  data,
  height = 200,
  formatValue,
}: {
  data: Point[];
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const hasData = data.some((d) => d.value != null);
  if (!hasData) {
    return (
      <div
        className="flex items-center justify-center rounded-[14px] border border-card-border bg-card"
        style={{ height }}
      >
        <p className="label">No data yet</p>
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: LABEL, fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          minTickGap={28}
        />
        <YAxis
          tick={{ fill: LABEL, fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={34}
          allowDecimals={false}
        />
        <Tooltip cursor={{ stroke: GRID }} content={renderTooltip(formatValue) as never} />
        <Line
          type="monotone"
          dataKey="value"
          stroke={LINE}
          strokeWidth={2}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Tiny axis-less sparkline for the pillar cards. */
export function SparkLine({ data, height = 44 }: { data: Point[]; height?: number }) {
  if (!data.some((d) => d.value != null)) {
    return <div style={{ height }} className="flex items-center"><span className="label">--</span></div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 2, bottom: 6, left: 2 }}>
        <Line
          type="monotone"
          dataKey="value"
          stroke={LINE}
          strokeWidth={1.5}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
