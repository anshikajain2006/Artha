import { useState, useEffect } from 'react';
import { useNavigate }         from 'react-router-dom';
import useAuth                 from '../hooks/useAuth';
import { getEmailPreference, upsertEmailPreference } from '../lib/db';

// ── Design tokens ─────────────────────────────────────────────────────────────

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
} as const;

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: {
  checked:  boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width:        48,
        height:       26,
        borderRadius: 13,
        background:   checked ? C.gold : C.s2,
        border:       `1px solid ${checked ? C.gold : C.border}`,
        cursor:       disabled ? 'not-allowed' : 'pointer',
        position:     'relative',
        flexShrink:   0,
        transition:   'background 0.2s ease, border-color 0.2s ease',
        opacity:      disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position:   'absolute',
          top:        3,
          left:       checked ? 23 : 3,
          width:      18,
          height:     18,
          borderRadius: '50%',
          background: checked ? C.bg : C.subtle,
          transition: 'left 0.2s ease, background 0.2s ease',
        }}
      />
    </button>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

export default function Settings() {
  const navigate         = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [digestEnabled, setDigestEnabled] = useState(true);
  const [prefLoading,   setPrefLoading]   = useState(true);
  const [saving,        setSaving]        = useState(false);
  const [savedMsg,      setSavedMsg]      = useState('');

  // Load existing preference on mount
  useEffect(() => {
    if (!user) return;
    getEmailPreference(user.id).then((pref) => {
      if (pref) {
        setDigestEnabled(pref.weekly_digest_enabled);
      } else {
        // No row yet — default is on; we'll create it on first toggle
        setDigestEnabled(true);
      }
      setPrefLoading(false);
    });
  }, [user]);

  async function handleToggle(next: boolean) {
    if (!user?.email) return;
    setDigestEnabled(next);
    setSaving(true);
    setSavedMsg('');
    try {
      await upsertEmailPreference(user.id, user.email, next);
      setSavedMsg(next ? 'Digest emails enabled.' : 'Digest emails disabled.');
      setTimeout(() => setSavedMsg(''), 3000);
    } finally {
      setSaving(false);
    }
  }

  if (authLoading) return null;

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>

      {/* ── Nav bar ────────────────────────────────────────────────────────── */}
      <header
        style={{
          background:   `${C.bg}ee`,
          borderBottom: `1px solid ${C.border}`,
          backdropFilter: 'blur(12px)',
          position:     'sticky',
          top:          0,
          zIndex:       50,
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin:   '0 auto',
            padding:  '0 16px',
            height:   56,
            display:  'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              fontFamily: '"Fraunces", serif',
              fontWeight: 300,
              fontSize:   20,
              letterSpacing: '-0.5px',
            }}
          >
            Arth<em style={{ color: C.gold, fontStyle: 'italic' }}>a</em>
          </span>

          <button
            onClick={() => navigate('/dashboard')}
            style={{
              background: 'none',
              border:     'none',
              color:      C.muted,
              cursor:     'pointer',
              fontSize:   13,
              fontFamily: '"DM Sans", sans-serif',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = C.text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = C.muted)}
          >
            ← Back to dashboard
          </button>
        </div>
      </header>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '48px 16px 80px' }}>

        <h1
          style={{
            fontFamily:    '"Fraunces", serif',
            fontWeight:    300,
            fontSize:      32,
            letterSpacing: '-0.5px',
            color:         C.text,
            margin:        '0 0 6px',
          }}
        >
          Settings
        </h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 40px' }}>
          Manage your account preferences.
        </p>

        {/* ── Email preferences section ───────────────────────────────────── */}
        <section>
          <p
            style={{
              fontSize:      10,
              fontWeight:    500,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color:         C.subtle,
              margin:        '0 0 16px',
            }}
          >
            Email Preferences
          </p>

          <div
            style={{
              background:   C.s1,
              border:       `1px solid ${C.border}`,
              borderRadius: 12,
              overflow:     'hidden',
            }}
          >
            {/* Weekly digest row */}
            <div
              style={{
                padding:        '20px 24px',
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'space-between',
                gap:            20,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 500, color: C.text }}>
                  Weekly digest emails
                </p>
                <p style={{ margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
                  {user?.email
                    ? `Sent every Sunday morning to ${user.email}`
                    : 'Sent every Sunday morning'}
                </p>
              </div>

              {prefLoading ? (
                <span
                  style={{
                    width:        48,
                    height:       26,
                    background:   C.s2,
                    borderRadius: 13,
                    flexShrink:   0,
                  }}
                />
              ) : (
                <Toggle
                  checked={digestEnabled}
                  onChange={handleToggle}
                  disabled={saving}
                />
              )}
            </div>

            {/* Digest description */}
            <div
              style={{
                borderTop: `1px solid ${C.border}`,
                padding:   '14px 24px',
                background: C.s2,
              }}
            >
              <p style={{ margin: 0, fontSize: 12, color: C.subtle, lineHeight: 1.7 }}>
                Each Sunday you'll receive a personalised AI summary of your portfolio's week —
                your health score, how you tracked against Nifty 50, and one specific action to
                consider. Delivered at 11:30 AM IST.
              </p>
            </div>
          </div>

          {/* Save feedback */}
          {savedMsg && (
            <p
              style={{
                marginTop: 12,
                fontSize:  12,
                color:     C.green,
              }}
            >
              ✓ {savedMsg}
            </p>
          )}
        </section>

      </main>
    </div>
  );
}
