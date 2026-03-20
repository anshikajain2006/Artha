import { useState, useEffect } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { initEmailPreferences } from '../lib/db';

interface AuthState {
  user:    User | null;
  session: Session | null;
  loading: boolean;
}

export default function useAuth() {
  const [state, setState] = useState<AuthState>({ user: null, session: null, loading: true });

  useEffect(() => {
    // Get the existing session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setState({ user: session?.user ?? null, session, loading: false });
    });

    // Subscribe to future auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setState({ user: session?.user ?? null, session, loading: false });
      // Ensure email_preferences row exists for every sign-in (new or returning)
      if (event === 'SIGNED_IN' && session?.user?.email) {
        void initEmailPreferences(session.user.id, session.user.email);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  return { ...state, signOut };
}
