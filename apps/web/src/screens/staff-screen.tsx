import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/button.jsx";
import { DataBoundary } from "../components/data-boundary.jsx";
import { Skeleton } from "@kelo/ui/react";
import { StepUpPrompt, type StepUpGrantResult } from "../components/step-up-prompt.jsx";
import { ApiRequestError, fetchEnvelope, postEnvelope } from "../lib/api.js";

type StaffRole = "owner" | "manager" | "front_desk" | "trainer";

interface StaffMember {
  id: string;
  user_id: string;
  role: StaffRole;
  status: "active" | "deactivated";
  pin_set: boolean;
  locked_until: string | null;
  fail_count: number;
  last_step_up_at: string | null;
  last_step_up_kind: string | null;
  is_self: boolean;
  can_manage_pin: boolean;
}

interface StaffResponse {
  staff: StaffMember[];
}

function roleLabel(role: StaffRole): string {
  return role.replace("_", " ");
}

function shortUserId(userId: string): string {
  return `${userId.slice(0, 8)}…${userId.slice(-4)}`;
}

function PinEditor({
  member,
  pending,
  error,
  onCancel,
  onSave,
}: {
  member: StaffMember;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{4,6}$/.test(pin) || pin !== confirmation) return;
    await onSave(pin);
    setPin("");
    setConfirmation("");
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-inverse px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-editor-title"
    >
      <form
        className="w-full max-w-sm rounded-3 border border-border-strong bg-surface-card p-6 shadow-3"
        onSubmit={(event) => void submit(event)}
      >
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">
          Staff credential
        </p>
        <h2 id="pin-editor-title" className="mt-1 font-display text-title font-bold text-ink">
          {member.pin_set ? "Reset PIN" : "Set PIN"}
        </h2>
        <p className="mt-2 text-body text-ink-secondary">
          Choose 4–6 digits. The PIN can only be changed here by the staff member or a higher-role
          manager—not through email recovery.
        </p>
        <label className="mt-5 block text-body font-medium text-ink" htmlFor="new-staff-pin">
          New PIN
        </label>
        <input
          id="new-staff-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={6}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
          className="mt-2 h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 font-mono text-title tracking-widest text-ink focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
        <label className="mt-4 block text-body font-medium text-ink" htmlFor="confirm-staff-pin">
          Confirm PIN
        </label>
        <input
          id="confirm-staff-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={6}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value.replace(/\D/g, "").slice(0, 6))}
          className="mt-2 h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 font-mono text-title tracking-widest text-ink focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
        {confirmation.length > 0 && confirmation !== pin && (
          <p role="alert" className="mt-3 text-body text-danger-on-tint">
            PINs do not match.
          </p>
        )}
        {error !== null && (
          <p role="alert" className="mt-3 text-body text-danger-on-tint">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!/^\d{4,6}$/.test(pin) || pin !== confirmation || pending}
          >
            {pending ? "Saving…" : "Save PIN"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function StaffScreen({ accessToken }: { accessToken: string | undefined }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [setError, setSetError] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [verifiedUntil, setVerifiedUntil] = useState<string | null>(null);
  const staffQuery = useQuery({
    queryKey: ["staff"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/staff", accessToken as string),
    retry: false,
  });
  const setPin = useMutation({
    mutationFn: ({ userId, pin }: { userId: string; pin: string }) =>
      postEnvelope(`/staff/${encodeURIComponent(userId)}/pin`, accessToken as string, { pin }),
    onSuccess: async () => {
      setEditing(null);
      setSetError(null);
      await queryClient.invalidateQueries({ queryKey: ["staff"] });
    },
    onError: (error) => {
      setSetError(
        error instanceof ApiRequestError
          ? error.message
          : "The PIN wasn’t saved. No credential was changed.",
      );
    },
  });

  async function verify(pin: string, context: string): Promise<StepUpGrantResult> {
    const response = (await postEnvelope("/staff/step-up/verify", accessToken as string, {
      pin,
      context,
    })) as {
      data?: { grant_token?: string; grant?: { expires_at?: string } };
    };
    const token = response.data?.grant_token;
    const expiresAt = response.data?.grant?.expires_at;
    if (token === undefined || expiresAt === undefined) {
      throw new Error("step-up response was missing its signed grant");
    }
    return { grantToken: token, expiresAt };
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">
            Staff · shared-device authorization
          </p>
          <h1 className="mt-1 font-display text-hero font-bold tracking-tight text-ink">
            Staff & roles
          </h1>
          <p className="mt-2 max-w-2xl text-body text-ink-secondary">
            Manage personal step-up PINs without exposing credential hashes. Every set and
            verification attempt is audited.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setStepUpOpen(true)}>
          Verify my PIN
        </Button>
      </header>

      {verifiedUntil !== null && (
        <p
          role="status"
          className="rounded-2 border border-success-border bg-success-tint px-4 py-2 text-body text-success-on-tint"
        >
          PIN verified. This test grant expires at {new Date(verifiedUntil).toLocaleTimeString()}.
        </p>
      )}

      <DataBoundary<StaffResponse>
        name="staff-roster"
        query={staffQuery}
        skeleton={<Skeleton className="h-80 w-full rounded-3" />}
        errorConsequence="The staff roster could not be shown; no role or PIN was changed."
      >
        {(data) => (
          <div className="overflow-hidden rounded-3 border border-hairline bg-surface-card shadow-1">
            <table className="w-full border-collapse text-left text-table">
              <thead className="bg-neutral-050 text-ink-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Staff identity</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">PIN</th>
                  <th className="px-4 py-3 font-medium">Last step-up</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.staff.map((member) => (
                  <tr key={member.id} className="border-t border-hairline">
                    <td className="px-4 py-3 font-mono text-ink">
                      {shortUserId(member.user_id)}
                      {member.is_self && <span className="ml-2 font-ui text-ink-muted">You</span>}
                    </td>
                    <td className="px-4 py-3 capitalize text-ink-secondary">
                      {roleLabel(member.role)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          member.locked_until === null
                            ? "text-ink-secondary"
                            : "font-medium text-danger-on-tint"
                        }
                      >
                        {member.locked_until !== null
                          ? "Locked"
                          : member.pin_set
                            ? "Set"
                            : "Not set"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {member.last_step_up_at === null
                        ? "Never"
                        : new Date(member.last_step_up_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {member.can_manage_pin && (
                        <Button
                          variant="ghost"
                          className="h-9"
                          onClick={() => {
                            setSetError(null);
                            setEditing(member);
                          }}
                        >
                          {member.pin_set ? "Reset PIN" : "Set PIN"}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataBoundary>

      {editing !== null && (
        <PinEditor
          member={editing}
          pending={setPin.isPending}
          error={setError}
          onCancel={() => setEditing(null)}
          onSave={async (pin) => {
            await setPin.mutateAsync({ userId: editing.user_id, pin });
          }}
        />
      )}
      <StepUpPrompt
        open={stepUpOpen}
        context="staff_access"
        onClose={() => setStepUpOpen(false)}
        onVerify={verify}
        onGranted={(grant) => {
          setVerifiedUntil(grant.expiresAt);
          setStepUpOpen(false);
        }}
      />
    </div>
  );
}
