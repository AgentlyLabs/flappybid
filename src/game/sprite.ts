// The bird, as pixels. Single source of truth for every place the bird is
// drawn: the header logo (SVG), the hero, and the game canvas.

export const BIRD_SPRITE = [
  "......KKKKK.....",
  "....KKYYYYYKK...",
  "...KYYYYYWWWK...",
  "..KYYYYYWWWWWK..",
  "..KYYYYYWWKWWK..",
  ".KCCCCYYWWKWWK..",
  ".KCCCCCYWWWWK...",
  ".KCCCCCYKKKKKKK.",
  ".KCCCCYKOOOOOOK.",
  "..KYYYYKDDDDDK..",
  "...KKYYYYKKKK...",
  ".....KKKKK......",
];

export const BIRD_SPRITE_W = 16;
export const BIRD_SPRITE_H = 12;

export const BIRD_PALETTE: Record<string, string> = {
  K: "#26221c", // outline
  Y: "#f8c840", // body
  C: "#fdf0ca", // wing / belly
  W: "#ffffff", // eye
  O: "#f87317", // beak
  D: "#d95a13", // beak, lower lip
};
