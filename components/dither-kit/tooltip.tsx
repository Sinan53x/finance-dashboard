"use client"

import { AnimatePresence, motion } from "motion/react"
import { useLayoutEffect, useRef, useState } from "react"
import { useCommonChart } from "./common-context"
import { cn } from "./lib"
import { rgb } from "./palette"

export type TooltipVariant = "default" | "frosted-glass"

const VARIANT: Record<TooltipVariant, string> = {
  default: "bg-popover",
  "frosted-glass": "bg-popover/70 backdrop-blur-sm",
}

/**
 * Floating hover tooltip. Reads the shared common context so it works in every
 * chart family. It glides between points and fades in/out (instead of snapping),
 * and dims unselected series/slices.
 */
export function Tooltip({
  labelKey,
  labelFormatter,
  valueFormatter,
  variant = "default",
}: {
  labelKey?: string
  /** Formats the heading (e.g. an ISO date → `dd.mm.yyyy`). */
  labelFormatter?: (label: string) => string
  valueFormatter?: (value: number, name: string) => string
  variant?: TooltipVariant
}) {
  const chart = useCommonChart()
  const show = chart.ready && chart.hoverIndex != null

  // Retain the last hovered index so the card keeps its content while fading
  // out — adjust-state-during-render (no refs in render).
  const [lastIndex, setLastIndex] = useState(0)
  if (chart.hoverIndex != null && chart.hoverIndex !== lastIndex) {
    setLastIndex(chart.hoverIndex)
  }
  const index = chart.hoverIndex ?? lastIndex

  const rawHeading = chart.heading(index, labelKey)
  const heading =
    rawHeading && labelFormatter ? labelFormatter(rawHeading) : rawHeading
  const items = chart.itemsAt(index)

  // Measure the card and clamp/flip it inside the chart container: centred on
  // the cursor by default, flipped left/below near the right/top edges.
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0, cw: 0, ch: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const cw = parent.clientWidth
    const ch = parent.clientHeight
    if (w !== box.w || h !== box.h || cw !== box.cw || ch !== box.ch) {
      setBox({ w, h, cw, ch })
    }
  }, [index, items.length, box.w, box.h, box.cw, box.ch])

  const measured = box.w > 0 && box.cw > 0
  const pad = 4
  const left = measured
    ? Math.min(Math.max(chart.tooltipLeft - box.w / 2, pad), box.cw - box.w - pad)
    : chart.tooltipLeft
  let top = measured ? chart.tooltipTop - box.h - 8 : chart.tooltipTop
  if (measured && top < pad) top = chart.tooltipTop + 8 // flip below the cursor
  if (measured) top = Math.min(top, box.ch - box.h - pad)

  return (
    <AnimatePresence>
      {show && items.length > 0 && (
        <motion.div
          key="dither-tooltip"
          ref={ref}
          initial={{ opacity: 0, top, left }}
          animate={{ opacity: measured ? 1 : 0, top, left }}
          exit={{ opacity: 0 }}
          transition={{
            type: "spring",
            stiffness: 520,
            damping: 38,
            mass: 0.6,
          }}
          className={cn(
            "pointer-events-none absolute z-10 min-w-24 rounded-md border px-2 py-1 whitespace-nowrap shadow-sm",
            VARIANT[variant]
          )}
        >
          {heading && (
            <div className="mb-0.5 font-mono text-[10px] text-muted-foreground">
              {heading}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {items.map((item) => (
              <div
                key={item.name}
                className="flex items-center gap-1.5 font-mono text-[11px] text-popover-foreground tabular-nums"
                style={{ opacity: item.dimmed ? 0.4 : 1 }}
              >
                <span
                  className="size-2 rounded-[1px]"
                  style={{ backgroundColor: rgb(item.seed.fill) }}
                />
                <span className="text-muted-foreground">{item.label}</span>
                <span className="ml-auto pl-2 text-foreground">
                  {valueFormatter
                    ? valueFormatter(item.value, item.name)
                    : item.value.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

Tooltip.chartLayer = "dom" as const
