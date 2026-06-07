// lucide-style line icons — recreated from the prototype (16px default, 1.5px stroke, currentColor).
import type { CSSProperties, ReactElement, ReactNode } from 'react'

interface IconProps {
  d?: string
  size?: number
  fill?: string
  children?: ReactNode
  viewBox?: string
  strokeWidth?: number
  style?: CSSProperties
  className?: string
}

export function Icon({
  d,
  size = 16,
  fill,
  children,
  viewBox = '0 0 24 24',
  strokeWidth = 1.5,
  style,
  className
}: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill={fill || 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
      aria-hidden="true"
    >
      {d ? <path d={d} /> : children}
    </svg>
  )
}

type IconProp = { size?: number; style?: CSSProperties; strokeWidth?: number; className?: string }
type IconFn = (p?: IconProp) => ReactElement

export const Icons: Record<string, IconFn> = {
  search: (p) => (
    <Icon {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  ),
  settings: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </Icon>
  ),
  paperclip: (p) => (
    <Icon {...p}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Icon>
  ),
  arrowUp: (p) => (
    <Icon {...p}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </Icon>
  ),
  copy: (p) => (
    <Icon {...p}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  ),
  refresh: (p) => (
    <Icon {...p}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </Icon>
  ),
  more: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </Icon>
  ),
  x: (p) => (
    <Icon {...p}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  ),
  check: (p) => (
    <Icon {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  ),
  chevronDown: (p) => (
    <Icon {...p}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  ),
  chevronRight: (p) => (
    <Icon {...p}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  ),
  chevronLeft: (p) => (
    <Icon {...p}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  ),
  plus: (p) => (
    <Icon {...p}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Icon>
  ),
  arrowRight: (p) => (
    <Icon {...p}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Icon>
  ),
  edit: (p) => (
    <Icon {...p}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </Icon>
  ),
  trash: (p) => (
    <Icon {...p}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Icon>
  ),
  download: (p) => (
    <Icon {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </Icon>
  ),
  eye: (p) => (
    <Icon {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  ),
  eyeOff: (p) => (
    <Icon {...p}>
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <path d="m2 2 20 20" />
    </Icon>
  ),
  external: (p) => (
    <Icon {...p}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Icon>
  ),
  alert: (p) => (
    <Icon {...p}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  ),
  plug: (p) => (
    <Icon {...p}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </Icon>
  ),
  users: (p) => (
    <Icon {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  ),
  sliders: (p) => (
    <Icon {...p}>
      <line x1="4" x2="4" y1="21" y2="14" />
      <line x1="4" x2="4" y1="10" y2="3" />
      <line x1="12" x2="12" y1="21" y2="12" />
      <line x1="12" x2="12" y1="8" y2="3" />
      <line x1="20" x2="20" y1="21" y2="16" />
      <line x1="20" x2="20" y1="12" y2="3" />
      <line x1="2" x2="6" y1="14" y2="14" />
      <line x1="10" x2="14" y1="8" y2="8" />
      <line x1="18" x2="22" y1="16" y2="16" />
    </Icon>
  ),
  shield: (p) => (
    <Icon {...p}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z" />
    </Icon>
  ),
  info: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Icon>
  ),
  message: (p) => (
    <Icon {...p}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </Icon>
  ),
  corner: (p) => (
    <Icon {...p}>
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </Icon>
  ),
  command: (p) => (
    <Icon {...p}>
      <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
    </Icon>
  ),
  compass: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </Icon>
  ),
  clock: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Icon>
  ),
  at: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </Icon>
  ),
  file: (p) => (
    <Icon {...p}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
    </Icon>
  ),
  image: (p) => (
    <Icon {...p}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
    </Icon>
  ),
  sparkle: (p) => (
    <Icon {...p}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </Icon>
  ),
  plusCircle: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8" />
      <path d="M12 8v8" />
    </Icon>
  ),
  layoutGrid: (p) => (
    <Icon {...p}>
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </Icon>
  ),
  user: (p) => (
    <Icon {...p}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  ),
  globe: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </Icon>
  ),
  puzzle: (p) => (
    <Icon {...p}>
      <path d="M15.5 3.5a2 2 0 0 1 3 1.7V8h1.8a2 2 0 1 1 0 4H18.5v2.8a2 2 0 0 1-2.8 1.8 1.6 1.6 0 0 1-.9-1.5 1.5 1.5 0 0 0-3 0 1.6 1.6 0 0 1-.9 1.5A2 2 0 0 1 8 14.8V12H6.2a2 2 0 1 1 0-4H8V5.2a2 2 0 0 1 2-2c.7 0 1.3.4 1.6 1a1.5 1.5 0 0 0 2.8 0c.2-.4.6-.7 1.1-.7Z" />
    </Icon>
  ),
  terminal: (p) => (
    <Icon {...p}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </Icon>
  ),
  link: (p) => (
    <Icon {...p}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Icon>
  ),
  zap: (p) => (
    <Icon {...p}>
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </Icon>
  ),
  box: (p) => (
    <Icon {...p}>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </Icon>
  ),
  pin: (p) => (
    <Icon {...p}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Icon>
  ),
  archive: (p) => (
    <Icon {...p}>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </Icon>
  ),
  panelRight: (p) => (
    <Icon {...p}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </Icon>
  ),
  table: (p) => (
    <Icon {...p}>
      <path d="M12 3v18" />
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
    </Icon>
  ),
  note: (p) => (
    <Icon {...p}>
      <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5Z" />
      <path d="M15 3v6h6" />
    </Icon>
  ),
  target: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </Icon>
  ),
  kanban: (p) => (
    <Icon {...p}>
      <path d="M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z" />
      <path d="M8 7v7" />
      <path d="M12 7v4" />
      <path d="M16 7v9" />
    </Icon>
  ),
  calendarClock: (p) => (
    <Icon {...p}>
      <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
      <path d="M3 10h18" />
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <circle cx="17.5" cy="16.5" r="4.5" />
      <path d="M17.5 14.5v2l1.5 1" />
    </Icon>
  ),
  mail: (p) => (
    <Icon {...p}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </Icon>
  ),
  repeat: (p) => (
    <Icon {...p}>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </Icon>
  ),
  listChecks: (p) => (
    <Icon {...p}>
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </Icon>
  ),
  folder: (p) => (
    <Icon {...p}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  ),
  gitBranch: (p) => (
    <Icon {...p}>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Icon>
  ),
  grip: (p) => (
    <Icon {...p}>
      <circle cx="9" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="18" r="1" />
    </Icon>
  )
}
