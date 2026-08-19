---
name: rusted-warfare-modding
description: Develop, inspect, debug, validate, package, or migrate Rusted Warfare 1.14/1.15 directory mods and .rwmod archives. Use whenever work involves Rusted Warfare units, INI/template inheritance, mod-info.txt, maps, assets, localization, gameplay mechanics, release packaging, or loading failures.
---

# Rusted Warfare Modding

This is the project skill for Rusted Warfare 1.14/1.15 mod work. It is an internal engineering reference for `ohmytx`, not a substitute for testing in the target game build. Work in Chinese unless the user asks otherwise; keep configuration keys and paths in their engine spelling.

## Start Here

1. Identify the request class: create, alter, investigate a load failure, review, package, migrate, or performance/balance analysis.
2. Determine the exact game build and whether the target is an unpacked mod directory or a `.rwmod`. Do not assume all 1.15 patch features are present.
3. Read `mod-info.txt`, the affected `.ini`, all direct `copyFrom` targets, the nearest effective `all-units.template`, and referenced assets before proposing an edit. For a review, also build a unit-name/reference inventory.
4. Select the relevant reference file from `references/README.md`. Read only the needed field catalog section; do not invent fields from memory or from a third-party example.
5. Make the smallest coherent change. Retain existing project conventions unless they conflict with confirmed engine behavior.
6. Run the read-only audit before packaging. Then perform an in-game reload and the narrowest gameplay test that proves the requested behavior.

## Evidence Model

Mark important claims mentally with one of these classes. Do not blur them in user-facing advice.

| Class | Meaning | How to act |
| --- | --- | --- |
| Engine-confirmed | Observed in the raw local game loader for the relevant build | Treat as a compatibility constraint |
| Catalog-confirmed | Present in the maintained field catalog but not rechecked in the raw loader during this task | Verify when behavior matters |
| Project convention | A deliberate organization or naming pattern in the target project | Follow unless it obstructs the task |
| Sample observation | Seen in DeepStar or an instance archive | Use as a test case, never as a rule |
| Hypothesis | Not yet supported by evidence | Label it and avoid shipping it as fact |

When materials disagree, use this order: the raw local loader under `W:\mao\tx\tools\decompilers\game-lib-src` for engine semantics; then its carefully derived internal summary in `W:\mao\tx\模组加载器`; then the local field catalog in `assets/ai/references/rusted-warfare-modding.md`; then the target mod's own established conventions; then other sample archives. The loader tree is internal material. Never copy or publish it, its source text, or protected assets as part of an answer or release. `W:\mao\tx\模组实例\特殊` is a read-only overlapping subset of the parent archive corpus, not an additional source of reusable code.

## Non-Negotiable Loader Facts

- The display metadata key is `[mod]title`, not `[mod]name`.
- `.rwmod` is a ZIP-backed virtual filesystem. Normal gameplay loading does not require extracting it. A single wrapper folder is tolerated by the loader, but an intentional, unambiguous package root is still preferred.
- `mod-info.txt` is the package entry point. `title`, `description`, `thumbnail`, and `minVersion` have actual loader meaning. Do not replace a missing manifest with a guessed filename at release time.
- A directory-level `all-units.template` automatically supplies defaults to units below it; a nearer template context supersedes an ancestor context. It is not merely an optional file that units must enumerate manually.
- `copyFrom` applies defaults, so child keys win. Its comma-separated inputs are resolved in reverse order, have a depth limit, and reject `..`.
- `@copyFromSection` is a different section-level operation. Keep both inheritance mechanisms visible during review.
- A parser-unused key can make a mod fail to load. A key that looks plausible is not therefore accepted. `strictLevel: 1` turns some otherwise recoverable concerns into errors.
- The inspected loader has no general mod dependency, `include`, `exclude`, or package load-order mechanism. Do not design a feature around one.

Read `references/12-known-limitations-and-errata.md` before relying on a simulator or legacy guide statement.

## Request Workflows

### Create A Mod Or Unit

1. Establish game version, desired faction/build source, display name, runtime `name`, construction route, movement type, player-visible behavior, and test map.
2. Choose the smallest existing template family that genuinely fits. Read it before adding `copyFrom`; do not stack templates to conceal unknown defaults.
3. Assign a global runtime unit ID, stable filename, local/shared assets, and a narrow build path. IDs, tags, action IDs, resource names, effects, projectiles, turrets, and template sections need their own uniqueness scope.
4. Add minimal valid core/graphics/attack/movement data appropriate to the unit. Use explicit `canAttack: false` for noncombat logic units where the project pattern expects it instead of faking a weapon.
5. Resolve every asset and every cross-unit reference, then audit and reload in game before extending mechanics.

### Change Existing Content

1. State the observed behavior and desired behavior separately. A request for a number change can expose an inherited value rather than a local value.
2. Map the effective definition: local file, all parent templates, sibling section copies, generated action paths, resources, and referenced units.
3. Change the owning layer. Do not shadow a template field locally just to bypass a rule unless the resulting per-unit divergence is intentional and documented.
4. Preserve unrelated key order, comments, localization variants, and line endings. Use a focused diff.
5. Recheck changed references and test the actual player workflow, not only whether the unit appears in the editor.

### Debug A Loading Failure

1. Capture the exact game error and target game version. Never reduce an error to “syntax issue” without the file/section/key context.
2. Run `node .agents/skills/rusted-warfare-modding/scripts/audit-rwmod.mjs <mod-path>` for fast packaging and reference signals.
3. Start with manifest, archive root, source encoding, inheritance targets, missing assets, duplicate section identities, and unknown/unused keys.
4. Bisect only through copies or version control. Do not delete broad blocks in a user mod merely to make the loader advance.
5. For dynamic behavior that loads but misbehaves, use a minimal map and add temporary, reversible visual/state evidence. Remove debugging machinery before release.

### Review Or Audit

Review in this order: package safety, manifest/version, parser validity, inheritance, identifiers and cross references, assets/localization/maps, runtime behavior, then balance/performance. Findings must include severity, path, concise evidence, consequence, and a repair direction. Separate confirmed failures from static-analysis suspicions.

### Package Or Release

Read `references/07-packaging-release-and-regression.md`. Build a clean archive from a release staging directory, not from an editor cache. Verify it as an archive and again after installing it in the game’s mod directory. Keep the release source, manifest version, compatibility statement, and changelog consistent.

## Read Order By Topic

| Need | Read first |
| --- | --- |
| Trust, game versions, private-source rules | `references/00-source-authority-and-versioning.md` |
| `mod-info.txt`, folder scan, rwmod, ZIP encoding | `references/01-mod-discovery-rwmod-and-metadata.md` |
| INI parsing, templates, variables, inheritance | `references/02-ini-parser-templates-and-inheritance.md` |
| Unit field families and catalog routing | `references/03-unit-architecture-and-field-catalog-routing.md` |
| Actions, conditions, resources, effects, state | `references/04-actions-logic-resources-effects-and-state.md` |
| Images, sounds, localization, TMX/TSX, music | `references/05-assets-audio-localization-and-maps.md` |
| References, errors, strictness, debug protocol | `references/06-cross-references-validation-and-debugging.md` |
| Release and regression | `references/07-packaging-release-and-regression.md` |
| DeepStar design patterns | `references/08-case-study-abyss-stars.md` |
| ASEU design patterns and historical hazards | `references/09-case-study-aseu.md` |
| Third-party archive compatibility coverage | `references/10-instance-mod-compatibility-matrix.md` |
| Ready-to-use agent prompts | `references/11-agent-prompts-and-task-playbooks.md` |
| Simulator limits and known corrections | `references/12-known-limitations-and-errata.md` |

For exact field names and value grammar, consult the maintained catalog at `assets/ai/references/rusted-warfare-modding.md`, then validate a consequential claim against the relevant engine behavior. The catalog is navigation and vocabulary, not a licence to infer undocumented combinations. The source coverage record is `references/corpus-inventory.json`; it contains derived audit facts only.

## Implementation Rules

### Identity And References

- Treat `[core]name` as a global runtime identifier. Filenames and localized labels are not safe substitutes.
- Before introducing or renaming a unit, search all `builtFrom`, `canBuild`, `convertTo`, `overrideAndReplace`, `spawnUnits`, transport, action, and replacement references.
- Keep tags deliberate: normalize spelling/case, avoid spaces under strict mode, and document tags that cross faction boundaries.
- Prefer a small explicit reference graph over magic text parsing. Every expression-like field needs field-specific interpretation.

### Inheritance

- Draw the template chain before editing; distinguish automatic directory templates, file-level `copyFrom`, and section-level copies.
- Avoid circular or very deep inheritance even before the engine’s limit.
- Define a default only once. If a child overrides it, make the reason visible in nearby project documentation or a concise comment where local style uses comments.
- Do not use `IGNORE` as a way to silence a typo. It is a targeted parser escape hatch and should not conceal unresolved field ownership.

### Assets And Text

- Resolve local references from the config file’s effective resource base; use `ROOT:`, `CORE:`, or `SHARED:` only in fields that support them.
- Keep release asset names stable, filesystem-safe, and consistent in case. Do not assume Windows case insensitivity represents all runtime contexts.
- Add a default localized label/description as well as the required language variants. Dynamic text must remain safe when its expression has no value.
- A map release is complete only when TMX, TSX, tile images, preview image, and mod metadata paths are all verified together.

### State And Performance

- Model a mechanic as state, trigger, transition, observable consequence, and reset. Bound counter values and reason about repeated events.
- Use local resources for per-unit state and global resources for a shared economy. Do not substitute one for the other solely for convenience.
- Keep expensive scans, spawning, and visual effects bounded by distance, tags, cooldowns, and expected unit count. Test stress behavior on the map sizes users actually play.

## Audit Commands

The bundled auditor is read-only. It supports directories and `.rwmod` archives and reports archive safety, manifest basics, wrapper roots, common release debris, case collisions, selected asset paths, and selected local inheritance references.

```text
node .agents/skills/rusted-warfare-modding/scripts/audit-rwmod.mjs <mod-directory-or-rwmod> [--json]
node .agents/skills/rusted-warfare-modding/scripts/validate-skill.mjs
```

Audit success does not prove game runtime correctness. It does not evaluate all LogicBoolean semantics, merge every template, render every sprite, parse a TMX map as the game does, or replace an actual mod reload.

## Required Evidence Before Claiming Completion

For any code or package work, report:

1. What changed, with paths and behavior.
2. Which engine rule or project convention justified it.
3. Which static checks ran and their result.
4. Which in-game check ran, including game build/map/action/result. If it did not run, state that plainly and name the remaining uncertainty.
5. Any source/example limitation that can affect compatibility.

Never claim a mod is “fully compatible” from an archive scan or a copied sample alone. Never publish internal loader material, other creators’ full unit configurations, or assets under the guise of a debugging report.

## Response Shapes

Use the smallest one that fits.

**Creation/change**

```text
Goal: ...
Evidence read: ...
Effective ownership: ...
Change: ...
Validation: ...
Runtime check still required: ...
```

**Failure investigation**

```text
Confirmed cause: ...
Evidence: file / section / key / loader message
Fix: ...
Verification: ...
Residual risk: ...
```

**Review**

```text
[severity] path:line — finding
Impact: ...
Repair: ...
Evidence class: engine-confirmed / catalog-confirmed / sample observation
```

Do not include a generic tutorial when the user asked for a narrow edit. Do not make a field claim merely because an example mod appears to load.
