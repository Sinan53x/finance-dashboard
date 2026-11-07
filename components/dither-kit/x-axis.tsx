"use client"

import { useChartPart } from "./chart-context"

export function XAxis({
  dataKey,
  tickFormatter,
  tickMargin = 8,
  maxTicks = 8,
}: {
  dataKey?: string
  tickFormatter?: (value: unknown, index: number) => string
  tickMargin?: number
  maxTicks?: number
}) {
  const ctx = useChartPart("XAxis")
  if (!ctx.ready) return null

  // Width-based thinning: `maxTicks` caps the count, but labels also need
  // room — estimate each label at ~6.2px/char + padding (10px mono) and skip
  // ticks until a label fits its slot without overlapping its neighbours.
  const labels = ctx.data.map((row, i) => {
    const raw = dataKey ? row[dataKey] : i
    return tickFormatter ? tickFormatter(raw, i) : String(raw ?? "")
  })
  const longest = labels.reduce((m, l) => Math.max(m, l.length), 0)
  const estLabelWidth = longest * 6.2 + 8
  const slotSpacing = ctx.plot.width / Math.max(ctx.dataLength, 1)
  const step = Math.max(
    Math.ceil(ctx.dataLength / maxTicks),
    Math.ceil(estLabelWidth / slotSpacing),
    1
  )
  const y = ctx.plot.height + tickMargin

  return (
    <g className="fill-current font-mono text-[10px] text-muted-foreground">
      {labels.map((label, i) => {
        if (i % step !== 0) return null
        return (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: index is the stable x position
            key={i}
            x={ctx.xCenter(i) ?? 0}
            y={y}
            textAnchor="middle"
            dominantBaseline="hanging"
            fill="currentColor"
          >
            {label}
          </text>
        )
      })}
    </g>
  )
}
