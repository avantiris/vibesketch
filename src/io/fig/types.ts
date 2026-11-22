// Loose typings for the parts of the decoded Figma kiwi message the importer reads. Everything
// is optional: the schema travels with the file and differs between Figma versions.

export interface FigGuid { sessionID: number; localID: number }
export interface FigVec { x: number; y: number }
export interface FigColor { r: number; g: number; b: number; a: number }
export interface FigMatrix { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number }
export interface FigNumber { value: number; units?: string }

export interface FigPaint {
  type?: string;
  color?: FigColor;
  opacity?: number;
  visible?: boolean;
  blendMode?: string;
  stops?: { color?: FigColor; position?: number }[];
  transform?: FigMatrix;
  image?: { hash?: Uint8Array; name?: string };
  imageScaleMode?: string;
  scale?: number;
  rotation?: number;
  originalImageWidth?: number;
  originalImageHeight?: number;
  paintFilter?: Record<string, number>;
}

export interface FigEffect {
  type?: string;
  color?: FigColor;
  offset?: FigVec;
  radius?: number;
  spread?: number;
  visible?: boolean;
  blendMode?: string;
  showShadowBehindNode?: boolean;
  // noise / texture / glass style effects of newer schemas
  noiseSize?: FigVec | number;
  noiseSizeUniform?: number;
  density?: number;
  noiseType?: string;
  secondaryColor?: FigColor;
  opacity?: number;
  clipToShape?: boolean;
  [key: string]: unknown;
}

export interface FigGeometry { windingRule?: string; commandsBlob?: number; styleID?: number }

export interface FigTextData {
  characters?: string;
  characterStyleIDs?: number[];
  styleOverrideTable?: unknown[];
  lines?: unknown[];
}

export interface FigBaseline { position?: FigVec; width?: number; lineY?: number; lineHeight?: number; lineAscent?: number; firstCharacter?: number; endCharacter?: number }
export interface FigDerivedTextData { layoutSize?: FigVec; baselines?: FigBaseline[] }

export interface FigNode {
  guid?: FigGuid;
  phase?: string;
  parentIndex?: { guid?: FigGuid; position?: string };
  type?: string;
  name?: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  blendMode?: string;
  transform?: FigMatrix;
  size?: FigVec;
  fillPaints?: FigPaint[];
  strokePaints?: FigPaint[];
  backgroundPaints?: FigPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  strokeCap?: string;
  strokeJoin?: string;
  dashPattern?: number[];
  borderStrokeWeightsIndependent?: boolean;
  borderTopWeight?: number;
  borderBottomWeight?: number;
  borderLeftWeight?: number;
  borderRightWeight?: number;
  borderTopHidden?: boolean;
  borderBottomHidden?: boolean;
  borderLeftHidden?: boolean;
  borderRightHidden?: boolean;
  cornerRadius?: number;
  rectangleCornerRadiiIndependent?: boolean;
  rectangleTopLeftCornerRadius?: number;
  rectangleTopRightCornerRadius?: number;
  rectangleBottomLeftCornerRadius?: number;
  rectangleBottomRightCornerRadius?: number;
  effects?: FigEffect[];
  mask?: boolean;
  maskType?: string;
  maskIsOutline?: boolean;
  fillGeometry?: FigGeometry[];
  strokeGeometry?: FigGeometry[];
  vectorData?: { vectorNetworkBlob?: number; normalizedSize?: FigVec; styleOverrideTable?: FigNode[] };
  textData?: FigTextData;
  derivedTextData?: FigDerivedTextData;
  fontSize?: number;
  fontName?: { family?: string; style?: string; postscript?: string };
  lineHeight?: FigNumber;
  letterSpacing?: FigNumber;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textAutoResize?: string;
  textCase?: string;
  textDecoration?: string;
  booleanOperation?: string;
  frameMaskDisabled?: boolean;
  resizeToFit?: boolean;
  count?: number;
  starInnerScale?: number;
  arcData?: { startingAngle?: number; endingAngle?: number; innerRadius?: number };
  symbolData?: { symbolID?: FigGuid; symbolOverrides?: unknown[] };
  overrideKey?: FigGuid;
  backgroundColor?: FigColor;
  backgroundEnabled?: boolean;
  internalOnly?: boolean;
  isStateGroup?: boolean;
  handleMirroring?: string;
  styleID?: number;
  [key: string]: unknown;
}

export interface FigMessage {
  type?: string;
  nodeChanges?: FigNode[];
  blobs?: { bytes?: Uint8Array }[];
}
