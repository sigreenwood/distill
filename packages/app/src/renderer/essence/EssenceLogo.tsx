import React, { useId } from 'react';
import { ESSENCE_GEOMETRY as G, ESSENCE_STATES, type EssenceActivity } from './tokens';
import './essence.css';

export interface EssenceLogoProps {
  activity?: EssenceActivity;
  size?: number;
  /** Actual download/import fraction, 0..1; omit for an indeterminate animation. */
  progress?: number;
  label?: string;
  /** 'auto' respects the OS setting; 'off' also disables motion explicitly. */
  motion?: 'auto' | 'off';
  decorative?: boolean;
  className?: string;
  /** Change for each completion event to replay the one-shot finish animation. */
  completionKey?: string | number;
}

export function EssenceLogo({ activity = 'idle', size = 64, progress, label,
  motion = 'auto', decorative = false, className = '', completionKey = 0 }: EssenceLogoProps) {
  const uid = `essence-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const colours = ESSENCE_STATES[activity];
  const fraction = progress !== undefined && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null;
  const badge = activity === 'paused' || activity === 'error' || activity === 'complete';
  return <svg key={`${activity}-${completionKey}`} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"
    width={size} height={size} className={`distill-essence ${className}`}
    data-activity={activity} data-motion={motion} data-progress={fraction === null ? 'indeterminate' : 'determinate'}
    style={{ '--essence-start': colours.start, '--essence-end': colours.end } as React.CSSProperties}
    role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined}
    aria-labelledby={decorative ? undefined : `${uid}-title`} focusable="false">
    {!decorative && <title id={`${uid}-title`}>{label ?? `Distill — ${colours.label}`}</title>}
    <defs>
      <linearGradient id={`${uid}-paint`} x1="0" y1="0" x2=".8" y2="1">
        <stop className="essence__start" offset="0"/><stop className="essence__end" offset="1"/>
      </linearGradient>
      <mask id={`${uid}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256" style={{ maskType: 'luminance' }}>
        <path d={G.drop} fill="white"/>
        <path className="essence__quote-left" d={G.quoteLeft} fill="black"/>
        <path className="essence__quote-right" d={G.quoteRight} fill="black"/>
      </mask>
    </defs>
    <g className="essence__body">
      <g mask={`url(#${uid}-mask)`}>
        <path d={G.drop} fill={`url(#${uid}-paint)`}/>
        <rect className="essence__fill" x="42" y={fraction === null ? 20 : 236 - 216 * fraction} width="172" height={fraction === null ? 216 : 216 * fraction}/>
        <circle className="essence__glow" cx="128" cy="164" r="76"/>
      </g>
    </g>
    {activity === 'waiting' && <circle cx="200" cy="80" r="11" fill={colours.end}/>}
    {badge && <g className="essence__badge">
      <circle cx="202" cy="208" r="28" fill={colours.end} stroke="white" strokeWidth="5"/>
      {activity === 'paused' && <path d="M194 196 V220 M210 196 V220" stroke="white" strokeWidth="6" strokeLinecap="round"/>}
      {activity === 'error' && <><path d="M202 193 V208" stroke="white" strokeWidth="6" strokeLinecap="round"/><circle cx="202" cy="219" r="3" fill="white"/></>}
      {activity === 'complete' && <path d="M189 207 L198 216 L216 198" fill="none" stroke="white" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>}
    </g>}
  </svg>;
}
