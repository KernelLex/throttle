/**
 * Compose & schedule a campaign.
 *
 * The Delivery Planner beneath the form recomputes on every change, using the shared
 * `planSchedule()`. That is why the inputs are debounced into a separate piece of
 * state: the planner is cheap (10,000 recipients plans in well under 100ms) but
 * running it on literally every keystroke of a number field is wasted work.
 */

import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_LEADS_PER_CAMPAIGN, type PlanSender } from '@throttle/core';
import { ApiRequestError, api } from '../../lib/api';
import { formatNumber, toLocalInputValue } from '../../lib/utils';
import { Button, Input, Modal, Textarea, useToast } from '../../components/ui';
import { DeliveryPlanner } from './DeliveryPlanner';

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
}

/** Five minutes out — far enough to finish the form, near enough to demo. */
function defaultStartAt(): string {
  return toLocalInputValue(new Date(Date.now() + 5 * 60 * 1000));
}

export function ComposeModal({ open, onClose }: ComposeModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [startAt, setStartAt] = useState(defaultStartAt);
  const [gapSeconds, setGapSeconds] = useState(2);
  const [hourlyLimit, setHourlyLimit] = useState(200);

  const [recipients, setRecipients] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * One idempotency key per open of the modal.
   *
   * If the user double-clicks Schedule, or the response is lost to a flaky network
   * and they retry, the server returns the ORIGINAL campaign rather than creating a
   * second one. The key is regenerated when the form resets, so a genuine second
   * campaign is still possible.
   */
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const { data: senders = [] } = useQuery({
    queryKey: ['senders'],
    queryFn: () => api.senders.list(),
    enabled: open,
  });

  // Deferred so typing in a number field stays responsive; React renders the form
  // update immediately and the chart catches up.
  const deferredRecipientCount = useDeferredValue(recipients.length);
  const deferredGap = useDeferredValue(gapSeconds);
  const deferredLimit = useDeferredValue(hourlyLimit);
  const deferredStart = useDeferredValue(startAt);

  // Memoised so its identity is stable. Without this a new Date object every render
  // invalidates DeliveryPlanner's useMemo and re-plans the entire campaign on every
  // keystroke — invisible at 10 recipients, noticeable at 10,000.
  const plannedStartAt = useMemo(() => new Date(deferredStart), [deferredStart]);

  const planSenders: PlanSender[] = useMemo(
    () =>
      senders
        .filter((sender) => sender.isActive)
        .map((sender) => ({
          id: sender.id,
          label: sender.label,
          // Mirrors exactly what the server does in resolveSenders(): the campaign
          // limit is a CEILING on the sender's own, never a raise.
          hourlyLimit: Math.min(sender.hourlyLimit, deferredLimit),
          minGapMs: Math.max(sender.minGapMs, deferredGap * 1000),
        })),
    [senders, deferredLimit, deferredGap],
  );

  const parseFile = useMutation({
    mutationFn: (file: File) => api.leads.parse(file),
    onSuccess: (parsed, file) => {
      setRecipients(parsed.emails);
      setFileName(file.name);

      const notes: string[] = [`${formatNumber(parsed.validCount)} addresses detected`];
      if (parsed.duplicateCount > 0) notes.push(`${formatNumber(parsed.duplicateCount)} duplicates removed`);
      if (parsed.invalidCount > 0) notes.push(`${formatNumber(parsed.invalidCount)} invalid skipped`);
      if (parsed.truncated) notes.push(`capped at ${formatNumber(MAX_LEADS_PER_CAMPAIGN)}`);

      toast('success', notes.join(' · '));
    },
    onError: (error: ApiRequestError) => toast('error', error.message),
  });

  const schedule = useMutation({
    mutationFn: () =>
      api.campaigns.create(
        {
          name: name.trim(),
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
          : `Campaign scheduled — ${formatNumber(recipients.length)} emails queued.`,
      );
      // Refresh every view that now shows different data.
      void queryClient.invalidateQueries({ queryKey: ['emails'] });
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      resetForm();
      onClose();
    },
    onError: (error: ApiRequestError) => {
      setFieldErrors(error.fields ?? {});
      toast('error', error.message);
    },
  });

  function resetForm(): void {
    setName('');
    setSubject('');
    setBody('');
    setStartAt(defaultStartAt());
    setRecipients([]);
    setFileName(null);
    setFieldErrors({});
    idempotencyKeyRef.current = crypto.randomUUID();
  }

  // useCallback so the identity is stable across renders. Modal no longer depends on
  // this (see the ref note there), but an unstable handler is a latent footgun for
  // any effect or memo that legitimately does.
  const handleClose = useCallback((): void => {
    if (schedule.isPending) return; // don't abandon an in-flight submit
    onClose();
  }, [schedule.isPending, onClose]);

  const canSubmit =
    name.trim().length > 0 &&
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    recipients.length > 0 &&
    planSenders.length > 0 &&
    !schedule.isPending;

  const firstError = (field: string): string | undefined => fieldErrors[field]?.[0];

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Compose new email"
      description="Upload your leads, set the pacing, and preview exactly how it will be delivered."
      size="xl"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) schedule.mutate();
        }}
        className="max-h-[70vh] space-y-5 overflow-y-auto px-6 py-5"
      >
        {/* ── Content ──────────────────────────────────────────────────── */}
        <Input
          label="Campaign name"
          placeholder="Q4 outreach — fintech founders"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={firstError('name')}
          required
          maxLength={200}
        />

        <Input
          label="Subject"
          placeholder="Quick question about {{company}}"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          error={firstError('subject')}
          hint="Use {{email}} or any column from your CSV as a merge field."
          required
          maxLength={500}
        />

        <Textarea
          label="Body"
          placeholder={'Hi there,\n\nI noticed you\'re working on…'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          error={firstError('body')}
          required
          rows={6}
        />

        {/* ── Leads ────────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-ink-secondary">
            Leads
            <span className="ml-0.5 text-ink-muted" aria-hidden="true">*</span>
          </span>

          <div className="rounded-md border border-dashed border-line-strong bg-surface-2/40 px-4 py-5">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,.tsv"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) parseFile.mutate(file);
              }}
            />

            {recipients.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  {/* The count the brief explicitly asks for. */}
                  <p className="text-sm font-medium text-ink">
                    {formatNumber(recipients.length)} email address
                    {recipients.length === 1 ? '' : 'es'} detected
                  </p>
                  <p className="text-xs text-ink-muted">{fileName}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Replace file
                </Button>
              </div>
            ) : (
              <div className="text-center">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={parseFile.isPending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose a CSV or TXT file
                </Button>
                <p className="mt-2 text-xs text-ink-muted">
                  One address per line, or a column of addresses. Duplicates are removed
                  automatically.
                </p>
              </div>
            )}
          </div>
          {firstError('recipients') ? (
            <p role="alert" className="text-sm text-ink-secondary">{firstError('recipients')}</p>
          ) : null}
        </div>

        {/* ── Pacing ───────────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            label="Start time"
            type="datetime-local"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
            error={firstError('startAt')}
            required
          />
          <Input
            label="Delay between emails"
            type="number"
            min={0}
            max={3600}
            value={gapSeconds}
            onChange={(e) => setGapSeconds(Math.max(0, Number(e.target.value)))}
            hint="seconds, per sender"
            error={firstError('minGapMs')}
          />
          <Input
            label="Hourly limit"
            type="number"
            min={1}
            max={100000}
            value={hourlyLimit}
            onChange={(e) => setHourlyLimit(Math.max(1, Number(e.target.value)))}
            hint="per sender"
            error={firstError('hourlyLimitPerSender')}
          />
        </div>

        {/* ── ⭐ Live forecast ─────────────────────────────────────────── */}
        <DeliveryPlanner
          recipientCount={deferredRecipientCount}
          senders={planSenders}
          startAt={plannedStartAt}
          minGapMs={deferredGap * 1000}
        />
      </form>

      <div className="flex items-center justify-end gap-3 border-t border-line px-6 py-4">
        <Button type="button" variant="ghost" onClick={handleClose} disabled={schedule.isPending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => schedule.mutate()}
          disabled={!canSubmit}
          loading={schedule.isPending}
        >
          Schedule campaign
        </Button>
      </div>
    </Modal>
  );
}
