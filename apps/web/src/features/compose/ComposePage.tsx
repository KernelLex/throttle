/**
 * Compose New Email — a full page, as in the Figma (not a modal).
 *
 * Layout mirrors the design: back arrow + title, attachment / clock / Send Later
 * in the top right, then From, To (with chips and Upload List), Subject, the two
 * pacing fields, and the body with its formatting toolbar.
 *
 * The Delivery Planner sits beneath the pacing fields — it is this product's
 * reason for existing, and it belongs where the numbers that drive it are set.
 */

import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_LEADS_PER_CAMPAIGN, type PlanSender } from '@throttle/core';
import { ApiRequestError, api } from '../../lib/api';
import { formatNumber, toLocalInputValue } from '../../lib/utils';
import { useToast } from '../../components/ui';
import { DeliveryPlanner } from './DeliveryPlanner';
import { SendLaterPopover } from './SendLaterPopover';

interface ComposePageProps {
  onClose: () => void;
  onScheduled: () => void;
}

/** Five minutes out — enough time to finish the form, near enough to demo. */
const defaultStartAt = () => toLocalInputValue(new Date(Date.now() + 5 * 60 * 1000));

export function ComposePage({ onClose, onScheduled }: ComposePageProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [startAt, setStartAt] = useState(defaultStartAt);
  const [gapSeconds, setGapSeconds] = useState(2);
  const [hourlyLimit, setHourlyLimit] = useState(200);

  const [recipients, setRecipients] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [sendLaterOpen, setSendLaterOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * One idempotency key per compose session. A double-click or a retried submit
   * returns the original campaign instead of scheduling a second one.
   */
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const { data: senders = [] } = useQuery({
    queryKey: ['senders'],
    queryFn: () => api.senders.list(),
  });

  // Deferred so typing stays responsive while the planner recomputes.
  const deferredCount = useDeferredValue(recipients.length);
  const deferredGap = useDeferredValue(gapSeconds);
  const deferredLimit = useDeferredValue(hourlyLimit);
  const deferredStart = useDeferredValue(startAt);

  const plannedStartAt = useMemo(() => new Date(deferredStart), [deferredStart]);

  const planSenders: PlanSender[] = useMemo(
    () =>
      senders
        .filter((s) => s.isActive)
        .map((s) => ({
          id: s.id,
          label: s.label,
          // Mirrors the server exactly: the campaign limit is a CEILING on each
          // sender's own, never a raise.
          hourlyLimit: Math.min(s.hourlyLimit, deferredLimit),
          minGapMs: Math.max(s.minGapMs, deferredGap * 1000),
        })),
    [senders, deferredLimit, deferredGap],
  );

  const parseFile = useMutation({
    mutationFn: (file: File) => api.leads.parse(file),
    onSuccess: (parsed, file) => {
      setRecipients(parsed.emails);
      setFileName(file.name);

      const notes = [`${formatNumber(parsed.validCount)} addresses detected`];
      if (parsed.duplicateCount) notes.push(`${formatNumber(parsed.duplicateCount)} duplicates removed`);
      if (parsed.invalidCount) notes.push(`${formatNumber(parsed.invalidCount)} invalid skipped`);
      if (parsed.truncated) notes.push(`capped at ${formatNumber(MAX_LEADS_PER_CAMPAIGN)}`);
      toast('success', notes.join(' · '));
    },
    onError: (err: ApiRequestError) => toast('error', err.message),
  });

  const schedule = useMutation({
    mutationFn: () =>
      api.campaigns.create(
        {
          name: subject.trim() || 'Untitled campaign',
          subject: subject.trim(),
          body,
          recipients,
          startAt: new Date(startAt).toISOString(),
          minGapMs: gapSeconds * 1000,
          hourlyLimitPerSender: hourlyLimit,
        },
        idempotencyKeyRef.current,
      ),
    onSuccess: (result) => {
      toast(
        'success',
        result.deduplicated
          ? 'That campaign was already scheduled.'
          : `Scheduled — ${formatNumber(recipients.length)} emails queued.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['emails'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      onScheduled();
    },
    onError: (err: ApiRequestError) => {
      setFieldErrors(err.fields ?? {});
      toast('error', err.message);
    },
  });

  /** Accept addresses typed straight into the To field, comma or Enter separated. */
  const commitManual = useCallback(() => {
    const parts = manualEntry
      .split(/[,;\s]+/)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.includes('@'));
    if (parts.length === 0) return;
    setRecipients((prev) => [...new Set([...prev, ...parts])]);
    setManualEntry('');
  }, [manualEntry]);

  const canSubmit =
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    recipients.length > 0 &&
    planSenders.length > 0 &&
    !schedule.isPending;

  const firstError = (f: string) => fieldErrors[f]?.[0];

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            aria-label="Back"
            className="rounded-md p-1 text-ink transition-colors hover:bg-surface-2"
          >
            <svg className="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Compose New Email</h1>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach lead list"
            title="Attach lead list"
            className="relative rounded-md p-1.5 text-accent transition-colors hover:bg-surface-2"
          >
            <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 1 1 5.18 5.18l-9.2 9.2a1.83 1.83 0 1 1-2.59-2.6l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {recipients.length > 0 ? (
              <span className="absolute -right-0.5 -bottom-0.5 text-[10px] font-semibold text-accent">
                1
              </span>
            ) : null}
          </button>

          <div className="relative">
            <button
              onClick={() => setSendLaterOpen((v) => !v)}
              aria-label="Schedule send time"
              aria-expanded={sendLaterOpen}
              className="rounded-md p-1.5 text-accent transition-colors hover:bg-surface-2"
            >
              <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {sendLaterOpen ? (
              <SendLaterPopover
                value={startAt}
                onChange={setStartAt}
                onClose={() => setSendLaterOpen(false)}
              />
            ) : null}
          </div>

          <button
            onClick={() => schedule.mutate()}
            disabled={!canSubmit}
            className="h-10 rounded-pill border border-accent px-6 text-[15px] font-medium text-accent transition-colors hover:bg-accent-tint disabled:cursor-not-allowed disabled:opacity-40"
          >
            {schedule.isPending ? 'Scheduling…' : 'Send Later'}
          </button>
        </div>
      </header>

      {/* ── Form ─────────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-[1180px] space-y-1">
          {/* From — resolved server-side by health score, so it is informational. */}
          <Field label="From">
            <span className="inline-flex items-center gap-2 rounded-lg bg-surface-3 px-3.5 py-2 text-[15px] text-ink">
              {senders[0]?.fromEmail ?? 'No sender configured'}
              <svg className="size-4 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            {senders.length > 1 ? (
              <span className="ml-3 text-[13px] text-ink-muted">
                +{senders.length - 1} more — rotated automatically by health score
              </span>
            ) : null}
          </Field>

          {/* To — chips plus Upload List, exactly as the Figma shows. */}
          <Field label="To" error={firstError('recipients')}>
            <div className="flex flex-1 items-center gap-2 border-b border-line pb-2">
              <div className="flex min-h-9 flex-1 flex-wrap items-center gap-2">
                {recipients.slice(0, 3).map((email) => (
                  <span
                    key={email}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-accent bg-surface px-3 py-1 text-[13px] text-ink"
                  >
                    {email}
                    <button
                      onClick={() => setRecipients((prev) => prev.filter((r) => r !== email))}
                      aria-label={`Remove ${email}`}
                      className="text-ink-muted transition-colors hover:text-ink"
                    >
                      ×
                    </button>
                  </span>
                ))}

                {recipients.length > 3 ? (
                  <span
                    className="inline-flex items-center rounded-pill border border-accent px-3 py-1 text-[13px] text-ink"
                    title={`${formatNumber(recipients.length)} recipients in total`}
                  >
                    +{formatNumber(recipients.length - 3)}
                  </span>
                ) : null}

                <input
                  value={manualEntry}
                  onChange={(e) => setManualEntry(e.target.value)}
                  onBlur={commitManual}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      commitManual();
                    }
                  }}
                  placeholder={recipients.length === 0 ? 'recipient@example.com' : ''}
                  aria-label="Add recipient"
                  className="min-w-[200px] flex-1 bg-transparent py-1 text-[15px] text-ink outline-none placeholder:text-ink-muted"
                />
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt,.tsv"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) parseFile.mutate(file);
                }}
              />

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={parseFile.isPending}
                className="flex shrink-0 items-center gap-2 text-[15px] font-medium text-accent transition-opacity hover:opacity-80 disabled:opacity-50"
              >
                <svg className="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 16V4m0 0L7 9m5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {parseFile.isPending ? 'Parsing…' : 'Upload List'}
              </button>
            </div>
          </Field>

          {/* The detected-address count the brief asks for. */}
          {recipients.length > 0 ? (
            <p className="pl-[72px] text-[13px] text-ink-secondary">
              <span className="font-medium text-ink">
                {formatNumber(recipients.length)} email addresses
              </span>{' '}
              detected{fileName ? ` in ${fileName}` : ''} · duplicates removed
            </p>
          ) : null}

          <Field label="Subject" error={firstError('subject')}>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              maxLength={500}
              className="flex-1 border-b border-line bg-transparent pb-2 text-[15px] text-ink outline-none placeholder:text-ink-muted focus:border-accent"
            />
          </Field>

          {/* Pacing — the two fields the Figma places side by side. */}
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 pt-5">
            <label className="flex items-center gap-3 text-[15px] text-ink">
              Delay between 2 emails
              <input
                type="number"
                min={0}
                max={3600}
                value={gapSeconds}
                onChange={(e) => setGapSeconds(Math.max(0, Number(e.target.value)))}
                className="tabular h-9 w-[70px] rounded-md border border-line-strong bg-surface px-2 text-center text-[15px] text-ink outline-none focus:border-accent"
              />
              <span className="text-[13px] text-ink-muted">sec</span>
            </label>

            <label className="flex items-center gap-3 text-[15px] text-ink">
              Hourly Limit
              <input
                type="number"
                min={1}
                max={100000}
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(Math.max(1, Number(e.target.value)))}
                className="tabular h-9 w-[80px] rounded-md border border-line-strong bg-surface px-2 text-center text-[15px] text-ink outline-none focus:border-accent"
              />
              <span className="text-[13px] text-ink-muted">per sender</span>
            </label>

            <label className="flex items-center gap-3 text-[15px] text-ink">
              Start
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="h-9 rounded-md border border-line-strong bg-surface px-3 text-[15px] text-ink outline-none focus:border-accent"
              />
            </label>
          </div>
          {firstError('startAt') ? (
            <p role="alert" className="text-[13px] text-fail-ink">{firstError('startAt')}</p>
          ) : null}

          {/* ── Body ───────────────────────────────────────────────────────── */}
          <div className="pt-5">
            <div className="rounded-xl bg-surface-2 p-4">
              <input
                value=""
                readOnly
                tabIndex={-1}
                aria-hidden="true"
                placeholder="Type Your Reply..."
                className="pointer-events-none mb-3 w-full bg-transparent text-[15px] text-ink-muted outline-none"
              />

              <FormattingToolbar />

              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write your message. Use {{email}} or any CSV column as a merge field."
                rows={12}
                aria-label="Email body"
                className="mt-3 w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-muted"
              />
            </div>
            {firstError('body') ? (
              <p role="alert" className="mt-2 text-[13px] text-fail-ink">{firstError('body')}</p>
            ) : null}
          </div>

          {/* ── Delivery forecast ──────────────────────────────────────────── */}
          <div className="pt-8 pb-10">
            <DeliveryPlanner
              recipientCount={deferredCount}
              senders={planSenders}
              startAt={plannedStartAt}
              minGapMs={deferredGap * 1000}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <div className="py-2.5">
      <div className="flex items-center gap-4">
        <span className="w-14 shrink-0 text-[15px] text-ink-secondary">{label}</span>
        {children}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 pl-[72px] text-[13px] text-fail-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The formatting toolbar from the Figma.
 *
 * Presentational only, and deliberately so: the send path renders plain text and
 * a simple HTML part, because `{{key}}` substitution is all this product needs.
 * A real rich-text editor would mean accepting HTML from a campaign body and
 * rendering it — a stored-XSS surface added for a feature nobody asked for.
 */
function FormattingToolbar() {
  const Group = ({ children }: { children: React.ReactNode }) => (
    <div className="flex items-center gap-0.5">{children}</div>
  );
  const Btn = ({ d, label }: { d: string; label: string }) => (
    <span
      title={`${label} — formatting is presentational in this build`}
      className="flex size-8 cursor-default items-center justify-center rounded text-ink-secondary"
    >
      <svg className="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d={d} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
  const Div = () => <span className="mx-1.5 h-5 w-px bg-line-strong" />;

  return (
    <div
      aria-hidden="true"
      className="flex flex-wrap items-center gap-1 rounded-pill bg-surface px-3 py-1.5"
    >
      <Group>
        <Btn label="Undo" d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />
        <Btn label="Redo" d="m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3" />
      </Group>
      <Div />
      <Group>
        <Btn label="Text size" d="M4 7V5h16v2M9 19h6M12 5v14" />
      </Group>
      <Div />
      <Group>
        <Btn label="Bold" d="M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z" />
        <Btn label="Italic" d="M19 4h-9M14 20H5M15 4 9 20" />
        <Btn label="Underline" d="M6 4v6a6 6 0 0 0 12 0V4M4 20h16" />
      </Group>
      <Div />
      <Group>
        <Btn label="Align" d="M4 6h16M4 12h10M4 18h16" />
        <Btn label="Line height" d="M4 6h16M4 12h16M4 18h16" />
      </Group>
      <Div />
      <Group>
        <Btn label="Numbered list" d="M10 6h10M10 12h10M10 18h10M4 6h1v4M4 16h2v4H4z" />
        <Btn label="Bulleted list" d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
        <Btn label="Indent" d="M4 6h16M10 12h10M4 18h16M4 10l3 2-3 2" />
        <Btn label="Outdent" d="M4 6h16M10 12h10M4 18h16M7 10l-3 2 3 2" />
      </Group>
      <Div />
      <Group>
        <Btn label="Quote" d="M7 8H4v5h4v-1a4 4 0 0 1-1-3zM17 8h-3v5h4v-1a4 4 0 0 1-1-3z" />
        <Btn label="Blockquote" d="M4 6h16M4 12h10M4 18h16M18 11v6" />
        <Btn label="Strikethrough" d="M6 12h12M8 7a4 4 0 0 1 8 0M8 17a4 4 0 0 0 8 0" />
      </Group>
    </div>
  );
}
