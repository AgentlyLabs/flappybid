// The flappybid coin — a minted gold token drawn in SVG so it stays crisp at
// any size and reads clearly next to the header balance (the 🪙 emoji it
// replaced rendered as a muddy dark blob on most platforms). A vertical gold
// gradient gives it a struck-metal sheen, an embossed star marks it as premium
// currency, and a light band sweeps across on a loop so the coin catches the
// eye without being loud. Colors are theme-independent on purpose: a currency
// token should look the same in light and dark mode, so the dark rim is a fixed
// brown rather than the theme's --color-ink (which inverts to cream in dark).
export default function CoinIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="fb-coin-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe58f" />
          <stop offset="0.5" stopColor="#f5c842" />
          <stop offset="1" stopColor="#dfa028" />
        </linearGradient>
        <clipPath id="fb-coin-clip">
          <circle cx="10" cy="10" r="8.4" />
        </clipPath>
      </defs>

      {/* dark rim + minted body */}
      <circle cx="10" cy="10" r="9.2" fill="#2b2419" />
      <circle cx="10" cy="10" r="8.4" fill="url(#fb-coin-body)" />
      {/* embossed inner ring */}
      <circle
        cx="10"
        cy="10"
        r="6.6"
        fill="none"
        stroke="#d95a13"
        strokeWidth="1"
        opacity="0.5"
      />
      {/* embossed star */}
      <path
        d="M10 5.7 L11.12 8.46 L14.09 8.67 L11.81 10.59 L12.53 13.48 L10 11.9 L7.47 13.48 L8.19 10.59 L5.91 8.67 L8.88 8.46 Z"
        fill="#d95a13"
      />
      {/* light sweep — the "catch the eye" gleam, looping */}
      <g clipPath="url(#fb-coin-clip)">
        <g transform="rotate(18 10 10)">
          <rect x="-6" y="-2" width="4" height="24" fill="#ffffff" opacity="0.55">
            <animateTransform
              attributeName="transform"
              type="translate"
              from="-6 0"
              to="28 0"
              dur="2.8s"
              repeatCount="indefinite"
            />
          </rect>
        </g>
      </g>
      {/* fixed specular highlight */}
      <circle cx="7" cy="6.8" r="1.4" fill="#ffffff" opacity="0.6" />
    </svg>
  );
}
