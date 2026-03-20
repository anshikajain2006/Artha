import { useEffect, useRef } from 'react';
import {
  Chart,
  LineElement,
  PointElement,
  LineController,
  CategoryScale,
  LinearScale,
  Filler,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { HealthScoreEntry } from '../lib/db';

Chart.register(LineElement, PointElement, LineController, CategoryScale, LinearScale, Filler, Tooltip);

// ── Design tokens ──────────────────────────────────────────────────────────────

const C = {
  bg:     '#0a0a0b',
  s1:     '#111113',
  s2:     '#18181b',
  gold:   '#d4a843',
  text:   '#f0efe8',
  muted:  '#9b9a94',
  subtle: '#5a5955',
  border: '#2a2a2f',
  green:  '#4ead84',
  red:    '#e05252',
} as const;

// ── Milestones ─────────────────────────────────────────────────────────────────

const MILESTONES = [
  { score: 30, label: 'First Score',  icon: '◉' },
  { score: 50, label: 'Halfway',      icon: '◈' },
  { score: 70, label: 'Strong',       icon: '★' },
  { score: 90, label: 'Elite',        icon: '✦' },
];

function scoreColor(score: number): string {
  if (score >= 70) return C.green;
  if (score >= 40) return C.gold;
  return C.red;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// ── Placeholder ────────────────────────────────────────────────────────────────

function Placeholder() {
  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      gap:            12,
      padding:        '36px 0',
    }}>
      <span style={{ fontSize: 36, opacity: 0.25 }}>◈</span>
      <p style={{ color: C.subtle, fontSize: 13, margin: 0, textAlign: 'center', lineHeight: 1.6 }}>
        Run your first AI Health Analysis to start<br />tracking your score over time.
      </p>
    </div>
  );
}

// ── Sparkline chart ────────────────────────────────────────────────────────────

function Sparkline({ entries }: { entries: HealthScoreEntry[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef  = useRef<Chart | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const labels = entries.map((e) => formatDate(e.created_at));
    const data   = entries.map((e) => e.score);

    const gradient = canvas.getContext('2d')?.createLinearGradient(0, 0, 0, 120);
    gradient?.addColorStop(0,   'rgba(212,168,67,0.35)');
    gradient?.addColorStop(1,   'rgba(212,168,67,0)');

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data,
          borderColor:     C.gold,
          borderWidth:     2,
          pointRadius:     entries.length <= 10 ? 4 : 2,
          pointHoverRadius: 5,
          pointBackgroundColor: C.gold,
          fill:            true,
          backgroundColor: gradient ?? 'rgba(212,168,67,0.15)',
          tension:         0.35,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation:           { duration: 500 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: C.s2,
            borderColor:     C.border,
            borderWidth:     1,
            titleColor:      C.muted,
            bodyColor:       C.text,
            padding:         10,
            callbacks: {
              label: (ctx) => `Score: ${ctx.parsed.y}/100`,
            },
          },
        },
        scales: {
          x: {
            grid:   { color: C.border, drawTicks: false },
            border: { dash: [3, 3] },
            ticks: {
              color:     C.subtle,
              font:      { size: 10 },
              maxTicksLimit: 6,
              maxRotation: 0,
            },
          },
          y: {
            min:  0,
            max:  100,
            grid: { color: C.border, drawTicks: false },
            border: { dash: [3, 3] },
            ticks: {
              color:     C.subtle,
              font:      { size: 10 },
              stepSize:  25,
              callback:  (v) => `${v}`,
            },
          },
        },
      },
    };

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvas, config);

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [entries]);

  return (
    <div style={{ position: 'relative', height: 160, width: '100%' }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

interface Props {
  entries:  HealthScoreEntry[];
  loading:  boolean;
}

export default function ScoreHistoryCard({ entries, loading }: Props) {
  const latest   = entries[entries.length - 1];
  const previous = entries[entries.length - 2];
  const delta    = latest && previous ? latest.score - previous.score : null;

  // Which milestones has the user hit?
  const maxScore    = entries.length > 0 ? Math.max(...entries.map((e) => e.score)) : 0;
  const hitMilestones = MILESTONES.filter((m) => maxScore >= m.score);

  return (
    <div style={{
      background:   C.s1,
      border:       `1px solid ${C.border}`,
      borderRadius: 14,
      padding:      '20px 24px',
      display:      'flex',
      flexDirection: 'column',
      gap:           20,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{
            fontFamily: '"Fraunces", serif',
            fontWeight: 300,
            fontSize:   16,
            color:      C.text,
            margin:     0,
          }}>
            Score History
          </h2>
          <p style={{ color: C.muted, fontSize: 12, margin: '4px 0 0' }}>
            {entries.length > 0 ? `${entries.length} data point${entries.length !== 1 ? 's' : ''}` : 'No history yet'}
          </p>
        </div>

        {latest && (
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: 28, fontWeight: 600, color: scoreColor(latest.score), lineHeight: 1 }}>
              {latest.score}
            </span>
            <span style={{ fontSize: 14, color: C.muted }}>/100</span>
            {delta !== null && (
              <p style={{ fontSize: 12, color: delta >= 0 ? C.green : C.red, margin: '2px 0 0' }}>
                {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)} vs last
              </p>
            )}
          </div>
        )}
      </div>

      {/* Loading shimmer */}
      {loading && (
        <div style={{ height: 160, borderRadius: 8, background: C.s2, animation: 'shimmer 1.5s infinite' }} />
      )}

      {/* Chart or placeholder */}
      {!loading && entries.length === 0 && <Placeholder />}
      {!loading && entries.length > 0  && <Sparkline entries={entries} />}

      {/* Milestone chips */}
      {hitMilestones.length > 0 && (
        <div>
          <p style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, margin: '0 0 10px' }}>
            Milestones
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {hitMilestones.map((m) => (
              <span
                key={m.score}
                style={{
                  background:   C.s2,
                  border:       `1px solid ${C.gold}44`,
                  borderRadius: 99,
                  padding:      '5px 14px',
                  fontSize:     12,
                  color:        C.gold,
                  display:      'flex',
                  alignItems:   'center',
                  gap:          6,
                }}
              >
                {m.icon} {m.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
