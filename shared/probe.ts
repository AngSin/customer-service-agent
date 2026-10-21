import { z } from "zod";

export const probeSchema = z.strictObject({
  marker: z.string(),
  subject: z.literal("milestone-1-probe")
});

// A single test fixture, not commerce data or a Milestone 2 migration.
export async function readProbeMarker(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT value FROM milestone_probe WHERE id = ?")
    .bind("shared")
    .first<{ value: string }>();
  if (!row) throw new Error("Probe fixture is not initialized");
  return row.value;
}
