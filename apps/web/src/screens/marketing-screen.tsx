import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApprovalCeremony,
  type ApprovalDetail,
  type ApprovalCampaign,
} from "../components/approval-ceremony.jsx";
import { DataBoundary } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import { fetchEnvelope, postEnvelope } from "../lib/api.js";

interface CampaignListResponse {
  campaigns: ApprovalCampaign[];
}

const STATUS_ORDER: ApprovalCampaign["status"][] = [
  "pending_approval",
  "draft",
  "sending",
  "approved",
  "sent",
  "cancelled",
];

function CampaignList({
  campaigns,
  selected,
  onSelect,
}: {
  campaigns: ApprovalCampaign[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-5">
      {STATUS_ORDER.map((status) => {
        const rows = campaigns.filter((campaign) => campaign.status === status);
        if (rows.length === 0) return null;
        return (
          <section key={status} aria-labelledby={`campaigns-${status}`}>
            <h2 id={`campaigns-${status}`} className="font-mono text-micro uppercase tracking-wide text-ink-muted">
              {status.replaceAll("_", " ")} · {rows.length}
            </h2>
            <ul className="mt-2 space-y-2">
              {rows.map((campaign) => (
                <li key={campaign.id}>
                  <button
                    type="button"
                    aria-pressed={selected === campaign.id}
                    onClick={() => onSelect(campaign.id)}
                    className={`w-full rounded-2 border px-4 py-3 text-left text-body focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 ${
                      selected === campaign.id
                        ? "border-selected-border bg-selected-bg text-ink"
                        : "border-hairline bg-surface-card text-ink-secondary"
                    }`}
                  >
                    <span className="block font-medium text-ink">{campaign.name}</span>
                    <span className="mt-1 block font-mono text-micro uppercase tracking-wide text-ink-muted">
                      {campaign.channel}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function MarketingScreen({ accessToken }: { accessToken: string | undefined }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const campaignsQuery = useQuery({
    queryKey: ["marketing", "campaigns"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/marketing/campaigns", accessToken as string),
    retry: 1,
  });
  const campaignData =
    campaignsQuery.status === "success"
      ? ((campaignsQuery.data as { data?: CampaignListResponse }).data?.campaigns ?? [])
      : [];
  useEffect(() => {
    if (selected === null && campaignData[0] !== undefined) setSelected(campaignData[0].id);
  }, [campaignData, selected]);

  const detailQuery = useQuery({
    queryKey: ["marketing", "campaign", selected],
    enabled: accessToken !== undefined && selected !== null,
    queryFn: () => fetchEnvelope(`/marketing/campaigns/${selected as string}`, accessToken as string),
    retry: 1,
  });
  const approveMutation = useMutation({
    mutationFn: () =>
      postEnvelope(
        `/marketing/campaigns/${selected as string}/approve`,
        accessToken as string,
        {},
      ),
    onSuccess: async () => {
      // No optimistic status flip: only invalidate/refetch after server ack.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["marketing", "campaigns"] }),
        queryClient.invalidateQueries({ queryKey: ["marketing", "campaign", selected] }),
      ]);
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">Marketing · proposals require approval</p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight text-ink">Outreach campaigns</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">
          Lifecycle automations propose drafts. Nothing sends until an owner or manager completes the approval ceremony.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <aside className="lg:col-span-1">
          <DataBoundary<CampaignListResponse>
            name="marketing-campaign-list"
            query={campaignsQuery}
            skeleton={<Skeleton className="h-96 w-full rounded-3" />}
            errorConsequence="Campaign proposals could not be listed; no message was sent."
            isEmpty={(data) => data.campaigns.length === 0}
            emptyState={<EmptyState title="No campaign proposals yet." body="Daily lifecycle evaluation will place drafts here without sending them." />}
          >
            {(data) => <CampaignList campaigns={data.campaigns} selected={selected} onSelect={setSelected} />}
          </DataBoundary>
        </aside>

        <div className="lg:col-span-2">
          {selected === null ? (
            <EmptyState title="Choose a campaign." body="Select a proposal to review its audience, exclusions, and exact message." />
          ) : (
            <DataBoundary<ApprovalDetail>
              name="marketing-approval-ceremony"
              query={detailQuery}
              skeleton={<Skeleton className="h-96 w-full rounded-3" />}
              errorConsequence="The approval details did not load; no message was sent."
            >
              {(detail) => (
                <ApprovalCeremony
                  detail={detail}
                  onApprove={async () => {
                    await approveMutation.mutateAsync();
                  }}
                />
              )}
            </DataBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
