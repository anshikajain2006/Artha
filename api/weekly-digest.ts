/**
 * Weekly portfolio digest — triggered by Vercel cron every Sunday 06:00 UTC.
 *
 * Required env vars (set in Vercel Project Settings → Environment Variables):
 *   SUPABASE_URL              — same value as VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase Dashboard → Project Settings → API → service_role
 *   GEMINI_API_KEY            — Google AI Studio
 *   RESEND_API_KEY            — resend.com → API Keys
 *   CRON_SECRET               — auto-set by Vercel for cron auth
 *
 * Required Supabase migration (run once in SQL editor):
 *   CREATE TABLE email_preferences (
 *     user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 *     email                text NOT NULL,
 *     weekly_digest_enabled boolean NOT NULL DEFAULT true,
 *     last_sent_at         timestamptz
 *   );
 *   ALTER TABLE email_preferences ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Users manage own preferences" ON email_preferences
 *     FOR ALL USING (auth.uid() = user_id);
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient }                        from '@supabase/supabase-js';
import { Resend }                              from 'resend';
import { geminiGenerate }                      from './_gemini';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Holding {
  ticker:      string;
  name:        string;
  shares:      number;
  avgBuyPrice: number;
}

interface EmailPref {
  user_id:               string;
  email:                 string;
  weekly_digest_enabled: boolean;
}

interface HealthRow {
  score:      number;
  created_at: string;
}

// ── Supabase admin client (service role — bypasses RLS) ───────────────────────

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// ── Nifty 50 weekly return ────────────────────────────────────────────────────

async function fetchNiftyWeeklyReturn(): Promise<number> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=8d&interval=1d';
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Artha/1.0)' },
    });
    if (!res.ok) return 0;

    const json = await res.json() as {
      chart: { result: Array<{ indicators: { quote: Array<{ close: (number | null)[] }> } }> };
    };
    const closes = json.chart.result[0].indicators.quote[0].close.filter(
      (c): c is number => c !== null,
    );
    if (closes.length < 2) return 0;
    return ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  } catch {
    return 0;
  }
}

// ── Score-change text ─────────────────────────────────────────────────────────

function scoreChangeText(delta: number): string {
  if (delta > 0)  return `up ${delta} point${delta !== 1 ? 's' : ''}`;
  if (delta < 0)  return `down ${Math.abs(delta)} point${Math.abs(delta) !== 1 ? 's' : ''}`;
  return 'holding steady';
}

// ── Holdings summary for the prompt ──────────────────────────────────────────

function holdingsSummary(holdings: Holding[]): string {
  if (!holdings.length) return 'No holdings';
  const sorted = [...holdings].sort(
    (a, b) => b.shares * b.avgBuyPrice - a.shares * a.avgBuyPrice,
  );
  return sorted
    .slice(0, 6)
    .map((h) => {
      const val = Math.round(h.shares * h.avgBuyPrice).toLocaleString('en-IN');
      return `${h.ticker} ₹${val}`;
    })
    .join(', ') + (holdings.length > 6 ? ` + ${holdings.length - 6} more` : '');
}

// ── Gemini digest ─────────────────────────────────────────────────────────────

async function generateDigestText(params: {
  holdingsSummary: string;
  currentScore:    number;
  previousScore:   number | null;
  totalValue:      number;
  niftyReturn:     number;
  goalAmount:      number | null;
  horizon:         string | null;
}): Promise<string> {
  const { holdingsSummary: summary, currentScore, previousScore, totalValue, niftyReturn, goalAmount, horizon } = params;

  const fmtVal = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const scoreLine = previousScore !== null
    ? `Current health score: ${currentScore}/100\nHealth score last week: ${previousScore}/100\nScore change: ${currentScore - previousScore} points`
    : `Current health score: ${currentScore}/100`;

  const goalLine = goalAmount
    ? `Goal: ${fmtVal(goalAmount)}${horizon ? ` in ${horizon}` : ''}`
    : 'No specific goal set yet';

  const prompt = `Generate a weekly portfolio digest for an Indian investor.
Be warm but honest. Under 150 words total.

Their portfolio: ${summary}
${scoreLine}
Portfolio value: ${fmtVal(totalValue)}
Nifty 50 this week: ${niftyReturn >= 0 ? '+' : ''}${niftyReturn.toFixed(2)}%
${goalLine}

Write 3 short paragraphs:
1. How their portfolio did this week vs Nifty. Use ₹ amounts.
2. One thing they should do this week. Specific, actionable, Indian market only.
3. One encouraging sentence about their goal. Reference ${goalAmount ? fmtVal(goalAmount) : 'their goal'} specifically.

No greetings, no sign-offs. Just the 3 paragraphs.`;

  return geminiGenerate(process.env.GEMINI_API_KEY!, [{ text: prompt }]);
}

// ── Email HTML builder ────────────────────────────────────────────────────────

function buildEmailHtml(params: {
  email:         string;
  totalValue:    number;
  currentScore:  number;
  niftyReturn:   number;
  digestText:    string;
  actionLine:    string;
  scoreChangeTxt: string;
  sentDate:      string;
}): string {
  const { totalValue, currentScore, niftyReturn, digestText, actionLine, scoreChangeTxt, sentDate } = params;

  const fmtVal = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const niftyColor    = niftyReturn >= 0 ? '#4ead84' : '#e05252';
  const niftyFmt      = `${niftyReturn >= 0 ? '+' : ''}${niftyReturn.toFixed(2)}%`;
  const scoreColor    = currentScore >= 70 ? '#4ead84' : currentScore >= 45 ? '#d4a843' : '#e05252';

  // Split digest into paragraphs
  const paragraphs = digestText.split(/\n\n+/).filter(Boolean);

  // Highlight ₹ amounts in gold
  function highlightRupees(text: string): string {
    return text.replace(/(₹[\d,]+)/g, '<span style="color:#f0efe8;font-weight:500">$1</span>');
  }

  const paragraphsHtml = paragraphs.map((p) =>
    `<p style="margin:0 0 18px 0;font-size:14px;line-height:1.8;color:#9b9a94;">${highlightRupees(p)}</p>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your Artha Digest — ${scoreChangeTxt} this week</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0b;font-family:Arial,Helvetica,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0b;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- ── Header ──────────────────────────────────────────── -->
          <tr>
            <td style="background:#111113;border:1px solid #2a2a2f;border-radius:14px 14px 0 0;padding:32px 32px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-family:Georgia,serif;font-weight:300;font-size:36px;color:#f0efe8;letter-spacing:-1px;line-height:1;">
                      Arth<em style="color:#d4a843;font-style:italic;">a</em>
                    </span>
                    <br>
                    <span style="font-size:11px;color:#5a5955;letter-spacing:0.12em;text-transform:uppercase;font-weight:500;">
                      Weekly Portfolio Digest
                    </span>
                  </td>
                  <td align="right" valign="bottom">
                    <span style="font-size:12px;color:#5a5955;">${sentDate}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── Stats row ───────────────────────────────────────── -->
          <tr>
            <td style="background:#111113;border-left:1px solid #2a2a2f;border-right:1px solid #2a2a2f;padding:0 32px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="33%" align="center" style="padding:20px 8px;border-right:1px solid #2a2a2f;">
                    <p style="margin:0 0 6px;font-size:10px;color:#5a5955;letter-spacing:0.12em;text-transform:uppercase;">Portfolio Value</p>
                    <p style="margin:0;font-family:Georgia,serif;font-size:26px;color:#f0efe8;font-weight:300;">${fmtVal(totalValue)}</p>
                  </td>
                  <td width="33%" align="center" style="padding:20px 8px;border-right:1px solid #2a2a2f;">
                    <p style="margin:0 0 6px;font-size:10px;color:#5a5955;letter-spacing:0.12em;text-transform:uppercase;">Health Score</p>
                    <p style="margin:0;font-family:Georgia,serif;font-size:26px;color:${scoreColor};font-weight:300;">${currentScore}<span style="font-size:14px;color:#5a5955;">/100</span></p>
                  </td>
                  <td width="33%" align="center" style="padding:20px 8px;">
                    <p style="margin:0 0 6px;font-size:10px;color:#5a5955;letter-spacing:0.12em;text-transform:uppercase;">Nifty 50</p>
                    <p style="margin:0;font-family:Georgia,serif;font-size:26px;color:${niftyColor};font-weight:300;">${niftyFmt}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── Divider ─────────────────────────────────────────── -->
          <tr>
            <td style="background:#111113;border-left:1px solid #2a2a2f;border-right:1px solid #2a2a2f;padding:0 32px;">
              <hr style="border:none;border-top:1px solid #2a2a2f;margin:0;">
            </td>
          </tr>

          <!-- ── AI Digest text ──────────────────────────────────── -->
          <tr>
            <td style="background:#111113;border-left:1px solid #2a2a2f;border-right:1px solid #2a2a2f;padding:28px 32px;">
              ${paragraphsHtml}
            </td>
          </tr>

          <!-- ── Action card ─────────────────────────────────────── -->
          <tr>
            <td style="background:#111113;border-left:1px solid #2a2a2f;border-right:1px solid #2a2a2f;padding:0 32px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#0f0e0a;border-left:3px solid #d4a843;border-radius:0 8px 8px 0;padding:14px 18px;">
                    <p style="margin:0 0 6px;font-size:10px;color:#d4a843;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;">This week's action</p>
                    <p style="margin:0;font-size:14px;color:#f0efe8;line-height:1.6;">${highlightRupees(actionLine)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── CTA button ──────────────────────────────────────── -->
          <tr>
            <td style="background:#111113;border:1px solid #2a2a2f;border-top:none;border-radius:0 0 14px 14px;padding:24px 32px 32px;" align="center">
              <a href="https://artha.vercel.app/dashboard"
                 style="display:inline-block;background:#d4a843;color:#0a0a0b;text-decoration:none;font-size:14px;font-weight:600;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                View full dashboard →
              </a>
            </td>
          </tr>

          <!-- ── Footer ─────────────────────────────────────────── -->
          <tr>
            <td align="center" style="padding:20px 0 8px;">
              <p style="margin:0;font-size:10px;color:#5a5955;line-height:1.6;">
                Don't want these emails?<br>
                Update preferences in your Artha dashboard under Settings.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel cron sends the CRON_SECRET as a Bearer token
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = adminClient();
  const resend   = new Resend(process.env.RESEND_API_KEY!);

  // ── 1. Fetch all opted-in users ─────────────────────────────────────────────
  const { data: prefs, error: prefsError } = await supabase
    .from('email_preferences')
    .select('user_id, email')
    .eq('weekly_digest_enabled', true);

  if (prefsError || !prefs) {
    console.error('Failed to fetch email preferences:', prefsError);
    return res.status(500).json({ error: 'Failed to fetch preferences' });
  }

  // ── 2. Fetch Nifty 50 weekly return once (shared across all emails) ─────────
  const niftyReturn = await fetchNiftyWeeklyReturn();

  const sentDate = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const results: { userId: string; status: 'sent' | 'skipped' | 'error'; reason?: string }[] = [];

  // ── 3. Process each user ────────────────────────────────────────────────────
  for (const pref of prefs as EmailPref[]) {
    try {
      // 3a. Fetch portfolio
      const { data: portRow } = await supabase
        .from('portfolios')
        .select('holdings')
        .eq('user_id', pref.user_id)
        .single();

      const rawHoldings = portRow?.holdings;
      const holdings: Holding[] = Array.isArray(rawHoldings)
        ? (rawHoldings as Holding[])
        : typeof rawHoldings === 'string'
        ? (JSON.parse(rawHoldings) as Holding[])
        : [];

      if (!holdings.length) {
        results.push({ userId: pref.user_id, status: 'skipped', reason: 'empty portfolio' });
        continue;
      }

      // 3b. Compute total invested value
      const totalValue = holdings.reduce((sum, h) => sum + h.shares * h.avgBuyPrice, 0);

      // 3c. Fetch last 2 health scores
      const { data: scoreRows } = await supabase
        .from('health_scores')
        .select('score, created_at')
        .eq('user_id', pref.user_id)
        .order('created_at', { ascending: false })
        .limit(2);

      const scores = (scoreRows as HealthRow[] | null) ?? [];
      const currentScore  = scores[0]?.score  ?? computeBasicScore(holdings);
      const previousScore = scores[1]?.score  ?? null;

      // 3d. Fetch goal from user metadata (stored via supabase.auth.updateUser)
      const { data: userData } = await supabase.auth.admin.getUserById(pref.user_id);
      const meta       = userData?.user?.user_metadata ?? {};
      const goalAmount = typeof meta.goal_amount === 'number' ? meta.goal_amount : null;
      const horizon    = typeof meta.horizon     === 'string' ? meta.horizon     : null;

      // 3e. Generate AI digest
      const digestText = await generateDigestText({
        holdingsSummary: holdingsSummary(holdings),
        currentScore,
        previousScore,
        totalValue,
        niftyReturn,
        goalAmount,
        horizon,
      });

      // Extract the second paragraph as the action line (fallback to first)
      const paras      = digestText.split(/\n\n+/).filter(Boolean);
      const actionLine = paras[1] ?? paras[0] ?? 'Review your portfolio on Artha this week.';

      // 3f. Build email
      const scoreDelta    = previousScore !== null ? currentScore - previousScore : 0;
      const scoreChangeTxt = previousScore !== null ? scoreChangeText(scoreDelta) : 'your weekly snapshot';
      const subject        = `Your Artha digest — ${scoreChangeTxt} this week`;

      const html = buildEmailHtml({
        email:         pref.email,
        totalValue,
        currentScore,
        niftyReturn,
        digestText,
        actionLine,
        scoreChangeTxt,
        sentDate,
      });

      // 3g. Send via Resend
      const { error: sendError } = await resend.emails.send({
        from:    'Artha <digest@updates.artha.app>',
        to:      [pref.email],
        subject,
        html,
      });

      if (sendError) {
        console.error(`Resend error for ${pref.email}:`, sendError);
        results.push({ userId: pref.user_id, status: 'error', reason: String(sendError) });
        continue;
      }

      // 3h. Update last_sent_at
      await supabase
        .from('email_preferences')
        .update({ last_sent_at: new Date().toISOString() })
        .eq('user_id', pref.user_id);

      results.push({ userId: pref.user_id, status: 'sent' });
    } catch (err) {
      console.error(`Digest failed for user ${pref.user_id}:`, err);
      results.push({ userId: pref.user_id, status: 'error', reason: String(err) });
    }
  }

  const sent    = results.filter((r) => r.status === 'sent').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const errors  = results.filter((r) => r.status === 'error').length;

  console.log(`Weekly digest: ${sent} sent, ${skipped} skipped, ${errors} errors`);
  return res.status(200).json({ sent, skipped, errors });
}

// ── Fallback: compute a basic health score from holdings alone ────────────────

function computeBasicScore(holdings: Holding[]): number {
  const n = holdings.length;
  const divScore = n === 0 ? 0 : n === 1 ? 5 : n === 2 ? 12 : n === 3 ? 18 : n <= 5 ? 23 : n <= 9 ? 27 : 30;
  // Without current prices we can't compute concentration/profitability accurately
  return Math.min(100, divScore + 18); // conservative mid estimate
}
