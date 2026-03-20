import { useState } from 'react';
import { supabase } from '../lib/supabase';

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
  red:    '#e05252',
  green:  '#4ead84',
} as const;

const inputStyle: React.CSSProperties = {
  width:       '100%',
  background:  C.s1,
  border:      `1px solid ${C.border}`,
  borderRadius: 8,
  padding:     '11px 14px',
  fontSize:    14,
  color:       C.text,
  outline:     'none',
  fontFamily:  '"DM Sans", system-ui, sans-serif',
  colorScheme: 'dark',
  boxSizing:   'border-box',
};

// ── Auth page ─────────────────────────────────────────────────────────────────

export default function AuthPage() {
  // Default to sign-in — most visitors are returning users
  const [mode,        setMode]       = useState<'signin' | 'signup'>('signin');
  const [email,       setEmail]      = useState('');
  const [password,    setPassword]   = useState('');
  const [loading,     setLoading]    = useState(false);
  const [error,       setError]      = useState('');
  const [info,        setInfo]       = useState('');   // green informational message
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resending,   setResending]  = useState(false);
  const [resendDone,  setResendDone] = useState(false);
  const [resetSent,   setResetSent]  = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  function switchMode(m: 'signin' | 'signup', keepEmail = false) {
    setMode(m);
    setError('');
    setInfo('');
    setNeedsVerify(false);
    setResetSent(false);
    if (!keepEmail) setEmail('');
    setPassword('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    setResetSent(false);
    setLoading(true);

    try {
      if (mode === 'signin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) {
          const msg = err.message.toLowerCase();
          if (msg.includes('email not confirmed')) {
            setNeedsVerify(true);
          } else if (msg.includes('invalid login credentials') || msg.includes('invalid_credentials')) {
            setError('Wrong password — try again or reset it below');
          } else if (msg.includes('user not found') || msg.includes('no user found')) {
            // Switch to sign-up with email pre-filled
            setMode('signup');
            setPassword('');
            setError('No account found — sign up instead');
          } else {
            setError(err.message);
          }
        }
      } else {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) {
          const msg = err.message.toLowerCase();
          if (msg.includes('already registered') || msg.includes('user already registered')) {
            // Switch to sign-in with email pre-filled and a friendly message
            setMode('signin');
            setPassword('');
            setInfo('You already have an account — sign in below');
          } else {
            setError(err.message);
          }
        } else if (data.session) {
          // Email confirmation OFF — signed in immediately
        } else {
          // Email confirmation ON — try silent sign-in; if it fails show verify screen
          const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
          if (signInErr) setNeedsVerify(true);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setError('');
    setLoading(true);
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options:  { redirectTo: window.location.origin + '/dashboard' },
      });
      if (err) setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setResending(true);
    await supabase.auth.resend({ type: 'signup', email });
    setResending(false);
    setResendDone(true);
  }

  async function handleForgotPassword() {
    if (!email) { setError('Enter your email above first'); return; }
    setResetLoading(true);
    setError('');
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/dashboard',
    });
    setResetLoading(false);
    setResetSent(true);
  }

  // ── Verify screen ────────────────────────────────────────────────────────────

  if (needsVerify) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
        <div style={{ maxWidth: 400, width: '100%', textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 24 }}>✉️</div>
          <h2 style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 26, color: C.text, margin: '0 0 12px' }}>
            Check your inbox
          </h2>
          <p style={{ fontSize: 14, color: C.muted, lineHeight: 1.7, margin: '0 0 32px' }}>
            We sent a confirmation link to <strong style={{ color: C.text }}>{email}</strong>.
            Click it to activate your account — this tab will update automatically.
          </p>
          <button
            onClick={() => void handleResend()}
            disabled={resending || resendDone}
            style={{
              background:   'none',
              border:       `1px solid ${C.border}`,
              borderRadius: 8,
              padding:      '10px 24px',
              fontSize:     13,
              color:        resendDone ? C.green : C.muted,
              cursor:       resendDone || resending ? 'default' : 'pointer',
              fontFamily:   '"DM Sans", sans-serif',
              marginBottom: 24,
            }}
          >
            {resendDone ? '✓ Sent again' : resending ? 'Sending…' : 'Resend confirmation email'}
          </button>
          <br />
          <button
            onClick={() => switchMode('signin')}
            style={{ background: 'none', border: 'none', color: C.gold, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            ← Back to sign in
          </button>
        </div>
      </div>
    );
  }

  // ── Main auth form ────────────────────────────────────────────────────────────

  return (
    <div className="entry-split">

      {/* ── Left branding panel ─────────────────────────────────────────────── */}
      <div className="entry-left">
        <div className="entry-left-inner">
          <h1 style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 120, letterSpacing: '-4px', color: C.text, margin: 0, lineHeight: 1 }}>
            Arth<em style={{ color: C.gold, fontStyle: 'italic' }}>a</em>
          </h1>
          <p style={{ marginTop: 28, fontSize: 22, color: C.muted, lineHeight: 1.8 }}>
            Portfolio intelligence for the Indian investor
          </p>
          <div style={{ marginTop: 52, marginBottom: 60, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', width: '100%' }}>
            {['✦ AI Health Score', '✦ Scenario Simulation', '✦ Goal Tracker'].map((pill) => (
              <span key={pill} style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 99, padding: '13px 32px', fontSize: 18, color: C.muted }}>
                {pill}
              </span>
            ))}
          </div>
        </div>
        <p style={{ position: 'absolute', bottom: 24, left: 0, right: 0, fontSize: 15, color: C.subtle, fontStyle: 'italic', textAlign: 'center', padding: '0 60px', margin: 0, lineHeight: 1.6 }}>
          Built for ₹50,000 portfolios and ₹50 crore portfolios alike.
        </p>
      </div>

      {/* ── Right auth panel ────────────────────────────────────────────────── */}
      <div className="entry-right" style={{ justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 400 }}>

          <h2 style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 28, letterSpacing: '-0.5px', color: C.text, margin: '0 0 6px' }}>
            {mode === 'signin' ? 'Sign in to Artha' : 'Create your account'}
          </h2>
          <p style={{ fontSize: 13, color: C.muted, margin: '0 0 28px' }}>
            Your portfolio, goals, and insights — all in one place.
          </p>

          {/* Friendly info message (e.g. "You already have an account") */}
          {info && (
            <p style={{ fontSize: 13, color: C.green, margin: '0 0 16px', lineHeight: 1.5 }}>
              {info}
            </p>
          )}

          {/* Google OAuth */}
          <button
            type="button"
            onClick={() => void handleGoogle()}
            disabled={loading}
            style={{
              width:          '100%',
              background:     C.s2,
              border:         `1px solid ${C.border}`,
              borderRadius:   8,
              padding:        '11px 0',
              fontSize:       14,
              color:          loading ? C.muted : C.text,
              cursor:         loading ? 'not-allowed' : 'pointer',
              fontFamily:     '"DM Sans", system-ui, sans-serif',
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              gap:            10,
              marginBottom:   16,
              opacity:        loading ? 0.6 : 1,
              transition:     'border-color 0.15s',
            }}
            onMouseEnter={(e) => { if (!loading) e.currentTarget.style.borderColor = '#38383f'; }}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = C.border)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {/* Divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1, height: 1, background: C.border }} />
            <span style={{ fontSize: 11, color: C.subtle, textTransform: 'uppercase', letterSpacing: '0.08em' }}>or</span>
            <div style={{ flex: 1, height: 1, background: C.border }} />
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              type="email"
              placeholder="Your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={inputStyle}
              onFocus={(e) => (e.currentTarget.style.borderColor = C.gold)}
              onBlur={(e)  => (e.currentTarget.style.borderColor = C.border)}
            />
            <input
              type="password"
              placeholder="Password (min 6 characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              style={inputStyle}
              onFocus={(e) => (e.currentTarget.style.borderColor = C.gold)}
              onBlur={(e)  => (e.currentTarget.style.borderColor = C.border)}
            />

            {error && <p style={{ fontSize: 12, color: C.red, margin: 0 }}>{error}</p>}

            {/* Forgot password — only visible on sign-in after a wrong-password error */}
            {mode === 'signin' && error.includes('Wrong password') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {resetSent ? (
                  <p style={{ fontSize: 12, color: C.green, margin: 0 }}>
                    ✓ Reset link sent to {email}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleForgotPassword()}
                    disabled={resetLoading}
                    style={{ background: 'none', border: 'none', color: C.gold, fontSize: 12, cursor: resetLoading ? 'default' : 'pointer', fontFamily: 'inherit', padding: 0, opacity: resetLoading ? 0.6 : 1 }}
                  >
                    {resetLoading ? 'Sending…' : 'Forgot password?'}
                  </button>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width:        '100%',
                background:   loading ? '#a0803a' : C.gold,
                color:        C.bg,
                border:       'none',
                borderRadius: 8,
                padding:      '12px 0',
                fontSize:     14,
                fontWeight:   600,
                cursor:       loading ? 'not-allowed' : 'pointer',
                fontFamily:   '"DM Sans", system-ui, sans-serif',
                marginTop:    4,
                transition:   'opacity 0.15s',
              }}
              onMouseEnter={(e) => { if (!loading) e.currentTarget.style.opacity = '0.88'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            >
              {loading ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          {/* Toggle between sign-in / sign-up */}
          <p style={{ fontSize: 13, color: C.muted, textAlign: 'center', marginTop: 20 }}>
            {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
              style={{ background: 'none', border: 'none', color: C.gold, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', padding: 0 }}
            >
              {mode === 'signin' ? 'Sign up free' : 'Sign in'}
            </button>
          </p>

        </div>
      </div>

    </div>
  );
}
