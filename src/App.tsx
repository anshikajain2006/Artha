import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import useAuth from './hooks/useAuth';
import { hasPortfolio } from './lib/db';
import { supabase } from './lib/supabase';
import AuthPage        from './pages/Auth';
import PortfolioEntry  from './components/PortfolioEntry';
import Dashboard       from './pages/Dashboard';
import Onboarding      from './pages/Onboarding';
import Settings        from './pages/Settings';
import FirstImpression from './pages/FirstImpression';

// ── Branded loading screen (shown while auth state is resolving) ──────────────

function LoadingScreen() {
  return (
    <div style={{
      width:           '100vw',
      height:          '100vh',
      background:      '#0a0a0b',
      display:         'flex',
      alignItems:      'center',
      justifyContent:  'center',
    }}>
      <div style={{
        fontFamily: '"Fraunces", Georgia, serif',
        fontSize:   '24px',
        color:      '#d4a843',
        fontStyle:  'italic',
      }}>
        Artha
      </div>
    </div>
  );
}

// ── Auth gate — redirects logged-in users away from the auth page ─────────────

function AuthGate() {
  const { user, loading } = useAuth();
  const [portfolioChecked, setPortfolioChecked] = useState(false);
  const [hasDB,            setHasDB]            = useState(false);

  useEffect(() => {
    if (!user) return;
    hasPortfolio(user.id).then((has) => {
      setHasDB(has);
      setPortfolioChecked(true);
    });
  }, [user]);

  // Never redirect while auth is resolving
  if (loading)           return <LoadingScreen />;
  if (!user)             return <AuthPage />;
  if (!portfolioChecked) return <LoadingScreen />;
  if (hasDB) {
    const shown = localStorage.getItem('artha_first_impression_shown');
    return <Navigate to={shown ? '/dashboard' : '/first-impression'} replace />;
  }
  return <Navigate to="/import" replace />;
}

// ── Route guard — redirects unauthenticated users to the auth page ────────────

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  // Never redirect while auth is still loading
  if (loading) return <LoadingScreen />;
  if (!user)   return <Navigate to="/auth" replace />;

  return <>{children}</>;
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const navigate = useNavigate();

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('Auth event:', event);
      if (event === 'SIGNED_IN' && session) {
        // Check portfolio existence before routing — Google OAuth users have no
        // onboarding_complete flag and must not land on an empty dashboard.
        hasPortfolio(session.user.id).then((hasDB) => {
          if (hasDB) {
            const shown = localStorage.getItem('artha_first_impression_shown');
            navigate(shown ? '/dashboard' : '/first-impression');
          } else {
            navigate('/import');
          }
        });
      }
    });
    return () => subscription.unsubscribe();
  }, [navigate]);

  return (
    <Routes>
      {/* Auth page — redirects away if already signed in */}
      <Route path="/"     element={<AuthGate />} />
      <Route path="/auth" element={<AuthGate />} />

      {/* Portfolio entry (import) — requires auth */}
      <Route
        path="/import"
        element={
          <RequireAuth>
            <PortfolioEntry />
          </RequireAuth>
        }
      />

      {/* Onboarding — requires auth */}
      <Route
        path="/onboarding"
        element={
          <RequireAuth>
            <Onboarding />
          </RequireAuth>
        }
      />

      {/* Dashboard — requires auth */}
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />

      {/* First Impression — requires auth */}
      <Route
        path="/first-impression"
        element={
          <RequireAuth>
            <FirstImpression />
          </RequireAuth>
        }
      />

      {/* Settings — requires auth */}
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <Settings />
          </RequireAuth>
        }
      />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/auth" replace />} />
    </Routes>
  );
}
