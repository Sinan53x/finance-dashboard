import { describe, expect, test } from "bun:test"
import { blend, paintColumn, type PixelBuffer } from "./dither-paint"
import { PALETTE } from "./palette"

const makeBuf = (width: number, height: number): PixelBuffer => ({
  data: new Uint8ClampedArray(width * height * 4),
  width,
  height,
})

const px = (b: PixelBuffer, x: number, y: number) => {
  const i = (y * b.width + x) * 4
  return [b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]]
}

const litPixels = (b: PixelBuffer) => {
  let n = 0
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i] > 0) n += 1
  return n
}

const litInColumn = (b: PixelBuffer, x: number) => {
  let n = 0
  for (let y = 0; y < b.height; y++) if (b.data[(y * b.width + x) * 4 + 3] > 0)
    n += 1
  return n
}

describe("blend", () => {
  test("alpha 0.5 onto transparent gives exact rgb and half alpha", () => {
    const b = makeBuf(2, 2)
    blend(b, 1, 1, [240, 70, 70], 0.5)
    expect(px(b, 1, 1)).toEqual([240, 70, 70, 128])
  })

  test("alpha 0.5 of A over opaque B averages the channels", () => {
    const b = makeBuf(2, 2)
    blend(b, 0, 0, [53, 143, 243], 1)
    blend(b, 0, 0, [240, 70, 70], 0.5)
    const [r, g, bl, a] = px(b, 0, 0)
    expect(a).toBe(255)
    expect(Math.abs(r - 0.5 * (240 + 53))).toBeLessThanOrEqual(1)
    expect(Math.abs(g - 0.5 * (70 + 143))).toBeLessThanOrEqual(1)
    expect(Math.abs(bl - 0.5 * (70 + 243))).toBeLessThanOrEqual(1)
  })

  test("0.5 over 0.5 of the same colour yields ~0.75 alpha", () => {
    const b = makeBuf(2, 2)
    blend(b, 0, 1, [150, 110, 255], 0.5)
    blend(b, 0, 1, [150, 110, 255], 0.5)
    const [r, g, bl, a] = px(b, 0, 1)
    expect([r, g, bl]).toEqual([150, 110, 255])
    expect(Math.abs(a - 0.75 * 255)).toBeLessThanOrEqual(1)
  })

  test("out-of-bounds and degenerate alphas leave the buffer untouched", () => {
    const b = makeBuf(3, 3)
    blend(b, -1, 0, [240, 70, 70], 1)
    blend(b, 3, 0, [240, 70, 70], 1)
    blend(b, 0, 3, [240, 70, 70], 1)
    blend(b, 0, -1, [240, 70, 70], 1)
    blend(b, 1, 1, [240, 70, 70], 0)
    blend(b, 1, 1, [240, 70, 70], Number.NaN)
    expect(litPixels(b)).toBe(0)
  })

  test("alpha clamps to 1 like CSS rgba", () => {
    const b = makeBuf(2, 2)
    blend(b, 0, 0, [240, 70, 70], 1.7)
    expect(px(b, 0, 0)).toEqual([240, 70, 70, 255])
  })
})

describe("paintColumn", () => {
  const seed = PALETTE.red

  test("floor <= top paints exactly the border pixel", () => {
    const b = makeBuf(4, 10)
    paintColumn(b, 2, 5, 5, seed, {
      variant: "solid",
      intensity: 0,
      dim: 1,
      stacked: false,
    })
    expect(litPixels(b)).toBe(1)
    const [r, , , a] = px(b, 2, 5)
    expect(r).toBe(240)
    expect(Math.abs(a - 0.72 * 255)).toBeLessThanOrEqual(1)
  })

  test("a depth-10 solid column paints its 10 rows and no neighbours", () => {
    const b = makeBuf(4, 14)
    paintColumn(b, 1, 2, 12, seed, {
      variant: "solid",
      intensity: 0,
      dim: 1,
      stacked: false,
    })
    expect(litInColumn(b, 1)).toBe(10)
    expect(litInColumn(b, 0)).toBe(0)
    expect(litInColumn(b, 2)).toBe(0)
    expect(litInColumn(b, 3)).toBe(0)
    expect(litPixels(b)).toBe(10)
  })
})
