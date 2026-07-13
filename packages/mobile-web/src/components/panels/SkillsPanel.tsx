import React from "react";
import { RefreshCw } from "lucide-react";
import { useMobileI18n } from "../../i18n/provider";
import type { SkillSummary } from "../../types";

interface SkillsPanelProps {
  skills: SkillSummary[];
  connectionStatus: "connecting" | "connected" | "disconnected";
  onReload: () => void;
  onSetSkillEnabled: (name: string, enabled: boolean) => Promise<void>;
}

interface SkillGroup {
  key: string;
  label: string;
  order: number;
  items: SkillSummary[];
}

type SkillGroupLabelKey = "agents" | "custom" | "other";

function resolveSkillGroup(scanRoot: string | undefined): {
  key: string;
  order: number;
  group: SkillGroupLabelKey;
} {
  const root = String(scanRoot || "");
  const lower = root.toLowerCase();

  if (lower.includes("/.agents/") || lower.includes("\\.agents\\")) {
    return { key: "agents", order: 2, group: "agents" };
  }
  if (
    lower.includes("gyshell") ||
    (lower.endsWith("/skills") && !lower.includes("/.")) ||
    lower.endsWith("\\skills")
  ) {
    return { key: "custom", order: 1, group: "custom" };
  }
  return {
    key: root || "other",
    order: 99,
    group: "other",
  };
}

export const SkillsPanel: React.FC<SkillsPanelProps> = ({
  skills,
  connectionStatus,
  onReload,
  onSetSkillEnabled,
}) => {
  const { t } = useMobileI18n();
  const [reloading, setReloading] = React.useState(false);
  const canMutate = connectionStatus === "connected";

  const groupedSkills = React.useMemo(() => {
    const groups: Record<string, SkillGroup> = {};
    for (const skill of skills) {
      const { key, order, group } = resolveSkillGroup(skill.scanRoot);
      if (!groups[key]) {
        groups[key] = { key, label: t.skills.groups[group], order, items: [] };
      }
      groups[key].items.push(skill);
    }
    return Object.values(groups).sort((a, b) => a.order - b.order);
  }, [skills, t.skills.groups]);

  const enabledCount = skills.filter((skill) => skill.enabled !== false).length;

  const toggleOne = React.useCallback(
    async (name: string, enabled: boolean) => {
      if (!canMutate) return;
      await onSetSkillEnabled(name, enabled);
    },
    [onSetSkillEnabled, canMutate],
  );

  const handleReload = React.useCallback(async () => {
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  }, [onReload]);

  return (
    <section className="panel-scroll skills-panel">
      <div className="panel-toolbar">
        <p className="panel-toolbar-meta">
          {t.skills.enabledCount(enabledCount, skills.length)}
        </p>
      </div>

      {skills.length === 0 ? (
        <p className="panel-empty">{t.skills.empty}</p>
      ) : (
        <div className="skill-sources">
          {groupedSkills.map((group) => {
            return (
              <section key={group.key} className="skill-source-group">
                <header className="skill-source-head">
                  <h3>{group.label}</h3>
                </header>

                <div className="skill-list">
                  {group.items.map((skill) => {
                    const isEnabled = skill.enabled !== false;
                    return (
                      <article key={skill.name} className="skill-item">
                        <div className="skill-item-body">
                          <h3>{skill.name}</h3>
                          <p>{skill.description || t.skills.noDescription}</p>
                        </div>
                        <button
                          type="button"
                          className={`skill-toggle ${isEnabled ? "enabled" : ""}`}
                          disabled={!canMutate}
                          onClick={() => void toggleOne(skill.name, !isEnabled)}
                        >
                          {isEnabled ? t.common.on : t.common.off}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <div className="panel-action-dock">
        <button
          type="button"
          className="panel-icon-btn panel-action-btn"
          disabled={!canMutate || reloading}
          onClick={handleReload}
          aria-label={t.skills.reload}
          title={t.skills.reload}
        >
          <RefreshCw size={18} className={reloading ? "spin" : ""} />
        </button>
      </div>
    </section>
  );
};
