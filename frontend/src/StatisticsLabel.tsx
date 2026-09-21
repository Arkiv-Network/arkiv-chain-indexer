import { InfoTooltip } from "./InfoTooltip";
import type { StatisticsExplanation } from "./statisticsHelp";

/** Shared presentation keeps every statistic's definition and qualifications easy to scan. */
export function StatisticsLabel({ label, explanation }: { label: string; explanation: StatisticsExplanation }) {
  return <span className="inline-flex items-center gap-1.5">
    <span>{label}</span>
    <StatisticsInfo label={label} explanation={explanation} />
  </span>;
}

export function StatisticsInfo({ label, explanation }: { label: string; explanation: StatisticsExplanation }) {
  return <InfoTooltip label={`About ${label}`}>
    <strong>{label}</strong>
    <p>{explanation.meaning}</p>
    <p><b className="font-semibold text-foreground">Source: </b>{explanation.source}</p>
    <p><b className="font-semibold text-foreground">Calculation: </b>{explanation.calculation}</p>
    <p><b className="font-semibold text-foreground">Conditions: </b>{explanation.conditions}</p>
    <p><b className="font-semibold text-foreground">Limitations: </b>{explanation.caveats}</p>
  </InfoTooltip>;
}
