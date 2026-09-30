/**
 * Add a sender.
 *
 * The API verifies the SMTP credentials with a real connection BEFORE saving, so a
 * typo surfaces here rather than three hours later when the first scheduled email
 * fails silently. That round-trip is why the submit button says "Verifying…".
 *
 * Presets exist because the host/port/TLS combination is the part people get wrong,
 * and getting it wrong produces an opaque connection error rather than anything
 * that points at the actual mistake.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, api } from '../../lib/api';
import { Button, Modal, useToast } from '../../components/ui';

interface AddSenderModalProps {
  open: boolean;
  onClose: () => void;
}

interface Preset {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  /** Shown under the password field — each provider calls its credential something different. */
  hint: string;
  userHint: string;
}

const PRESETS: Preset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    userHint: 'your full Gmail address',
    hint:
      'Not your Google password — a 16-character App Password. Requires 2-Step ' +
      'Verification, then generate one at myaccount.google.com/apppasswords. ' +
      'Limit: 500 emails/day.',
  },
  {
    id: 'brevo',
    label: 'Brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    userHint: 'your Brevo login email',
    hint: 'Found under SMTP & API → SMTP in the Brevo dashboard. Limit: 300 emails/day free.',
  },
  {
    id: 'ethereal',
    label: 'Ethereal (test)',
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    userHint: 'the generated Ethereal address',
    hint: 'Accepts mail and renders it at a preview URL, but never delivers it. Create one at ethereal.email/create.',
  },
  {
    id: 'custom',
    label: 'Custom',
    host: '',
    port: 587,
    secure: false,
    userHint: 'the SMTP username',
    hint: 'Port 587 with STARTTLS is the usual choice. Port 465 needs implicit TLS — tick "Use TLS" for that.',
  },
];

export function AddSenderModal({ open, onClose }: AddSenderModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [presetId, setPresetId] = useState('gmail');
  const preset = PRESETS.find((p) => p.id === presetId)!;

  const [label, setLabel] = useState('');
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [smtpHost, setSmtpHost] = useState(preset.host);
  const [smtpPort, setSmtpPort] = useState(preset.port);
  const [smtpSecure, setSmtpSecure] = useState(preset.secure);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [hourlyLimit, setHourlyLimit] = useState(200);
  const [gapSeconds, setGapSeconds] = useState(2);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function applyPreset(id: string): void {
    const next = PRESETS.find((p) => p.id === id)!;
    setPresetId(id);
    setSmtpHost(next.host);
    setSmtpPort(next.port);
    setSmtpSecure(next.secure);
  }

  const create = useMutation({
    mutationFn: () =>
      api.senders.create({
        label: label.trim(),
        fromName: fromName.trim(),
        fromEmail: fromEmail.trim().toLowerCase(),
        smtpHost: smtpHost.trim(),
        smtpPort,
        smtpUser: smtpUser.trim(),
        smtpPassword,
        smtpSecure,
        hourlyLimit,
        minGapMs: gapSeconds * 1000,
      }),
    onSuccess: (sender) => {
      toast('success', `${sender.label} verified and added.`);
      void queryClient.invalidateQueries({ queryKey: ['senders'] });
      reset();
      onClose();
    },
    onError: (err: ApiRequestError) => {
      setFieldErrors(err.fields ?? {});
      toast('error', err.message);
    },
  });

  function reset(): void {
    setLabel('');
    setFromName('');
    setFromEmail('');
    setSmtpUser('');
    setSmtpPassword('');
    setFieldErrors({});
  }

  const err = (f: string) => fieldErrors[f]?.[0];

  // fromEmail usually IS the SMTP username, so offer it rather than making the
  // user type the same address twice.
  const canCopyEmail = fromEmail.includes('@') && smtpUser !== fromEmail;

  const canSubmit =
    label.trim() &&
    fromName.trim() &&
    fromEmail.includes('@') &&
    smtpHost.trim() &&
    smtpUser.trim() &&
    smtpPassword &&
    !create.isPending;

  return (
    <Modal
      open={open}
      onClose={() => (create.isPending ? undefined : onClose())}
      title="Add sender"
      description="Credentials are verified against the server before anything is saved."
      size="lg"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
        className="max-h-[68vh] space-y-5 overflow-y-auto px-6 py-5"
      >
        {/* ── Provider ─────────────────────────────────────────────────── */}
        <div>
          <span className="mb-2 block text-sm font-medium text-ink-secondary">Provider</span>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                className={`rounded-pill px-4 py-2 text-sm font-medium transition-colors ${
                  presetId === p.id
                    ? 'bg-accent-tint text-accent ring-1 ring-inset ring-accent'
                    : 'bg-surface-2 text-ink-secondary hover:bg-surface-3'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-secondary">{preset.hint}</p>
        </div>

        {/* ── Identity ─────────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label" error={err('label')}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Outreach Four"
              className={input}
            />
          </Field>
          <Field label="From name" error={err('fromName')}>
            <input
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Amogh from Throttle"
              className={input}
            />
          </Field>
        </div>

        <Field
          label="From address"
          error={err('fromEmail')}
          hint="Appears as the sender. Must be an address this SMTP account may send as."
        >
          <input
            type="email"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            placeholder="you@gmail.com"
            className={input}
          />
        </Field>

        {/* ── Server ───────────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-[1fr_120px_auto]">
          <Field label="SMTP host" error={err('smtpHost')}>
            <input
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="smtp.gmail.com"
              className={input}
            />
          </Field>
          <Field label="Port" error={err('smtpPort')}>
            <input
              type="number"
              value={smtpPort}
              onChange={(e) => setSmtpPort(Number(e.target.value))}
              className={`${input} tabular`}
            />
          </Field>
          <div className="flex items-end pb-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
              <input
                type="checkbox"
                checked={smtpSecure}
                onChange={(e) => setSmtpSecure(e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              Use TLS
            </label>
          </div>
        </div>

        <Field label="SMTP username" error={err('smtpUser')} hint={preset.userHint}>
          <div className="flex gap-2">
            <input
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              placeholder="you@gmail.com"
              className={input}
            />
            {canCopyEmail ? (
              <button
                type="button"
                onClick={() => setSmtpUser(fromEmail)}
                className="shrink-0 rounded-lg px-3 text-sm font-medium text-accent transition-colors hover:bg-accent-tint"
              >
                Same as address
              </button>
            ) : null}
          </div>
        </Field>

        <Field label="SMTP password" error={err('smtpPassword')}>
          <input
            type="password"
            value={smtpPassword}
            onChange={(e) => setSmtpPassword(e.target.value)}
            placeholder={presetId === 'gmail' ? 'abcd efgh ijkl mnop' : '••••••••'}
            autoComplete="off"
            className={input}
          />
        </Field>

        {/* ── Pacing ───────────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Hourly limit"
            error={err('hourlyLimit')}
            hint="A campaign can lower this, never raise it."
          >
            <input
              type="number"
              min={1}
              value={hourlyLimit}
              onChange={(e) => setHourlyLimit(Math.max(1, Number(e.target.value)))}
              className={`${input} tabular`}
            />
          </Field>
          <Field label="Minimum gap" error={err('minGapMs')} hint="Seconds between sends.">
            <input
              type="number"
              min={0}
              value={gapSeconds}
              onChange={(e) => setGapSeconds(Math.max(0, Number(e.target.value)))}
              className={`${input} tabular`}
            />
          </Field>
        </div>

        <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-ink-secondary">
          The password is encrypted with AES-256-GCM before it is stored and is never
          returned by the API.
        </p>
      </form>

      <div className="flex items-center justify-end gap-3 border-t border-line px-6 py-4">
        <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button onClick={() => create.mutate()} disabled={!canSubmit} loading={create.isPending}>
          {create.isPending ? 'Verifying…' : 'Verify and add'}
        </Button>
      </div>
    </Modal>
  );
}

const input =
  'h-10 w-full rounded-lg bg-surface px-3.5 text-[15px] text-ink outline-none ' +
  'ring-1 ring-inset ring-line-strong transition-colors placeholder:text-ink-muted ' +
  'focus:ring-[1.5px] focus:ring-accent';

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink-secondary">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-xs text-fail-ink">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-ink-muted">{hint}</span>
      ) : null}
    </label>
  );
}
