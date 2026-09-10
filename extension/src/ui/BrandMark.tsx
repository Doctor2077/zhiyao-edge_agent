import { useId } from 'react';

/**
 * 执要 Agent 品牌标记（方案 D1 · 合符点睛，纯黑白）
 * - 方印：左半白、右半黑，锯齿相合
 * - 点睛：白半一颗黑点、黑半一颗白点（evenodd 镂空，自适应任何背景）
 * - currentColor：浅色主题显黑、深色主题显白
 */
export default function BrandMark({ size = 26 }: { size?: number }) {
  const clipId = useId();
  const clip = `seal-${clipId}`;
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <rect x="14" y="14" width="100" height="100" rx="16" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        {/* 黑半：锯齿形 + 白点镂空（evenodd） */}
        <path
          fillRule="evenodd"
          fill="currentColor"
          d="M 64 6 L 54 38 L 74 54 L 54 70 L 74 86 L 64 122 L 128 122 L 128 6 Z M 88 88 m -6 0 a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0 Z"
        />
        {/* 白半的黑点 */}
        <circle cx="40" cy="40" r="6" fill="currentColor" />
      </g>
      <rect
        x="14"
        y="14"
        width="100"
        height="100"
        rx="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="8"
      />
      <path
        d="M 64 6 L 54 38 L 74 54 L 54 70 L 74 86 L 64 122"
        fill="none"
        stroke="currentColor"
        strokeWidth="8"
      />
    </svg>
  );
}
