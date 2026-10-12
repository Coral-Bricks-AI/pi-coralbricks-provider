import { buildModels, transformApiModel } from "../index";
import patchData from "../patch.json" with { type: "json" };

export type FixtureModel = NonNullable<ReturnType<typeof transformApiModel>>;

/**
 * Coral /v1/models rows, shaped as the gateway returns them. Behaviour tests
 * build their own rows so a routine catalog sync — a new model, a delisting, a
 * price change — cannot break them. Where a test needs real curation it applies
 * the REAL patch.json on top, because patch.json is hand-edited and is the
 * regression guard for the curation (e.g. "the -fast model has no reasoning").
 */
export const DEEPSEEK_FLASH_ROW = {
  id: "deepseek-v4.1-flash-fast",
  object: "model",
  owned_by: "coralbricks",
  context_length: 1048576,
  supports_chat: true,
  supports_image_input: true,
  supports_tools: true,
  pricing: { cache_write_per_m: 0.08, cached_input_per_m: 0, input_per_m: 0.01, output_per_m: 1.2 },
};

export const GLM_FAST_ROW = {
  id: "glm-5.3-fast",
  object: "model",
  owned_by: "coralbricks",
  context_length: 1048576,
  supports_chat: true,
  supports_image_input: false,
  supports_tools: true,
  pricing: { cache_write_per_m: 0.56, cached_input_per_m: 0, input_per_m: 1.12, output_per_m: 4.4 },
};

/** Bare API rows (reasoning false, live pricing), before patch.json is applied. */
export const baseModels: FixtureModel[] = [
  transformApiModel(DEEPSEEK_FLASH_ROW)!,
  transformApiModel(GLM_FAST_ROW)!,
];

/** The catalog the provider actually serves: the fixture rows + real patch.json. */
export function fixtureCatalog(
  patch: Record<string, unknown> = patchData as unknown as Record<string, unknown>,
): FixtureModel[] {
  return buildModels(baseModels, [], patch as any);
}
