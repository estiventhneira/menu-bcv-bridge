// Typings for raster-text.mjs — the single-source raster text engine the app
// imports directly (src/lib/printing/escpos.ts) and the bridge bundles.
// Keep in sync with raster-text.mjs.

/** One atlas face: character → base64 of `cellH` rows × ceil(cellW/8) bytes. */
export interface RasterFontFace {
  [char: string]: string;
}

export interface RasterFont {
  name: string;
  cellW: number;
  cellH: number;
  faces: { regular: RasterFontFace; bold: RasterFontFace };
}

export interface RasterSegment {
  text: string;
  bold: boolean;
  wMul: number;
  hMul: number;
}

export interface ComposedLine {
  /** Trimmed to the last inked byte column; 0 = no ink on this line. */
  widthBytes: number;
  height: number;
  data: Uint8Array;
}

export type RasterAlign = "left" | "center" | "right";

export const RASTER_CELL_W: number;
export const RASTER_DEFAULT_PITCH: number;
export const RASTER_LINE_LEADING: number;

export function normalizeRasterText(font: RasterFont, s: string): string[];
export function paperDotsForWidth(paperWidthMm: number | null | undefined): number;
export function composeLine(
  font: RasterFont,
  segments: RasterSegment[],
  opts: { lineDots: number; align?: RasterAlign; charSpacing?: number },
): ComposedLine | null;

export class RasterTextEngine {
  constructor(font: RasterFont, opts: { lineDots: number });
  align(a: RasterAlign): void;
  style(s?: { bold?: boolean; doubleWidth?: boolean; doubleHeight?: boolean }): void;
  magnify(w: number, h: number): void;
  lineSpacing(dots: number): void;
  charSpacing(dots: number): void;
  text(s: string): number[];
  line(s?: string): number[];
  feed(n?: number): number[];
  flush(): number[];
  flushPending(): number[];
  blankAdvance(): number[];
  advanceBytes(dots: number): number[];
}
