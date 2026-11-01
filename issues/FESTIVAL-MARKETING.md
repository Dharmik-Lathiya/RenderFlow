# Festival Marketing Template Generator

**Feature plan — written before implementation.**

A company enters their brand details and an occasion (Diwali, Christmas, New Year,
Independence Day, etc.). RenderFlow picks a matching template, fills it with
brand-aware copy using the existing LLM pipeline, and generates a ready-to-post
image poster and a short reel using the existing `media-worker`. Credits are
consumed using the existing credit engine. The output lands in the campaign
dashboard ready for approval and scheduling.

This feature reuses the entire existing pipeline — no new workers, no new queues,
no new database clusters. It is a new UI flow + a new generation kind that
maps to existing stages.

---

## 1. Why this feature

- Every small Indian business needs Diwali/New Year social posts. It is a
  high-volume, high-repeat use case that demonstrates the value of the platform.
- It shows the **template-to-output** pipeline concretely — an interviewer can
  see exactly what credits buy.
- It exercises every part of the backend: credit reserve, outbox, content worker,
  media worker, checkpoint resume, SSE progress, approval, scheduling.

---

## 2. User journey

```
1. User is inside a Brand (already has logo, colors, tagline)
2. Clicks "Festival Campaign" button in the dashboard
3. Selects an occasion from a gallery:
   [ Diwali ]  [ Christmas ]  [ New Year ]  [ Independence Day ]
   [ Eid ]     [ Holi ]       [ Onam ]      [ Custom... ]
4. Enters campaign details:
   - Offer text:    "50% off all products this Diwali!"
   - CTA:           "Shop now at renderflow.store"
   - Language:      English / Hindi / Both
   - Output format: Image only | Image + Reel (15s)
5. Credit cost is shown: "This will use 6 credits (poster: 5, caption: 1)"
   Or: "This will use 36 credits (poster: 5, caption: 1, reel: 30)"
6. User clicks "Generate"
7. Credits are reserved. SSE progress bar appears:
   TEMPLATE_SELECT → COPY_FILL → IMAGE_RENDER → [REEL_RENDER] → DONE
8. Results appear in the campaign:
   - Branded poster (1080×1080 px, Instagram-ready)
   - Short reel (15s, brand colors + logo + offer text + background music)
   - AI-generated caption with hashtags
9. User approves and schedules for the occasion date
```

---

## 3. Template library design

Templates are JSON descriptors stored in the database (`festival_templates` table).
Each template defines:

```json
{
  "id": "diwali-2024-v1",
  "occasion": "DIWALI",
  "name": "Diwali Glow",
  "preview_url": "s3://renderflow/templates/diwali-2024-v1/preview.png",
  "slots": [
    { "id": "headline", "type": "text", "maxChars": 30, "position": "top-center" },
    { "id": "offer", "type": "text", "maxChars": 60, "position": "center" },
    { "id": "cta", "type": "text", "maxChars": 40, "position": "bottom-center" },
    { "id": "logo", "type": "image", "position": "top-left", "size": "80x80" },
    { "id": "background", "type": "image", "position": "full", "source": "template" }
  ],
  "color_scheme": {
    "primary": "{{ brand.primaryColor }}",
    "accent": "#FF9933",
    "background": "#1a1a2e"
  },
  "audio_track": "s3://renderflow/templates/diwali-2024-v1/bgm.mp3",
  "dimensions": { "width": 1080, "height": 1080 },
  "reel_duration_seconds": 15
}
```

**Occasions supported at launch:**
`DIWALI`, `CHRISTMAS`, `NEW_YEAR`, `INDEPENDENCE_DAY`, `EID`, `HOLI`, `ONAM`, `CUSTOM`

**Template storage:** S3 bucket `renderflow-templates`. Templates are seeded
in `pnpm db:seed` alongside `pricing_rules`. They do not change at runtime.

---

## 4. New generation kind: `FESTIVAL`

The existing `generation_jobs` table has a `kind` column. Add `FESTIVAL` as a new kind.

### Stage sequence for FESTIVAL

```
TEMPLATE_SELECT  →  COPY_FILL  →  IMAGE_RENDER  →  [REEL_RENDER]  →  DONE
      ↓                ↓               ↓                  ↓
  content-worker  content-worker  media-worker       media-worker
```

| Stage             | Worker           | What happens                                                                                                                                                                                       |
| ----------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEMPLATE_SELECT` | `content-worker` | Match occasion to best template. If multiple templates exist for the occasion, use LLM to pick based on brand voice. Write template id to checkpoint.                                              |
| `COPY_FILL`       | `content-worker` | LLM fills all text slots in the template using brand details + offer text. Also generates caption + hashtags. Validates against slot `maxChars`. Retry once with repair prompt on validation fail. |
| `IMAGE_RENDER`    | `media-worker`   | Composite the template background + logo + filled text slots using `sharp`. Save to S3. Write S3 key to checkpoint.                                                                                |
| `REEL_RENDER`     | `media-worker`   | FFmpeg: animate the poster (Ken Burns effect), overlay audio track, fade in brand name. 15s output. Save to S3. (Only if user selected "Image + Reel")                                             |
| `DONE`            | —                | Capture credits, mark job `COMPLETED`.                                                                                                                                                             |

### Stage machine change

In `libs/jobs/src/stage-machine.ts`, add:

```typescript
FESTIVAL_IMAGE: ['TEMPLATE_SELECT', 'COPY_FILL', 'IMAGE_RENDER'],
FESTIVAL_REEL:  ['TEMPLATE_SELECT', 'COPY_FILL', 'IMAGE_RENDER', 'REEL_RENDER'],
```

---

## 5. API changes

### New endpoints

```
GET  /api/v1/festival/occasions
  → Returns list of supported occasions with display names and icon URLs

GET  /api/v1/festival/templates?occasion=DIWALI
  → Returns templates for the occasion (id, name, preview_url, color_scheme)

POST /api/v1/campaigns/:campaignId/festival
  → Body: { occasionId, templateId?, offerText, ctaText, language, includeReel }
  → Reserves credits
  → Creates generation_job with kind=FESTIVAL
  → Returns { jobId, creditsReserved, estimatedSeconds }
```

The existing job progress SSE endpoint `GET /api/v1/jobs/:jobId/progress` works
unchanged — it streams stage updates by job id.

### New DB tables

```sql
-- Festival occasion catalogue
CREATE TABLE festival_occasions (
  id          TEXT PRIMARY KEY,       -- 'DIWALI', 'CHRISTMAS', etc.
  display_name TEXT NOT NULL,
  icon_url    TEXT,
  active      BOOLEAN DEFAULT true
);

-- Template library
CREATE TABLE festival_templates (
  id          TEXT PRIMARY KEY,
  occasion_id TEXT NOT NULL REFERENCES festival_occasions(id),
  name        TEXT NOT NULL,
  preview_url TEXT NOT NULL,
  slots       JSONB NOT NULL,
  color_scheme JSONB NOT NULL,
  audio_track TEXT,
  dimensions  JSONB NOT NULL,
  reel_duration_seconds INT,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

These tables are seeded with initial data in `pnpm db:seed`.

---

## 6. Frontend changes

### New pages / components

```
apps/web/app/dashboard/campaigns/[id]/festival/
  page.tsx           — occasion gallery + template picker + form
  components/
    OccasionGallery.tsx   — grid of occasion cards with icons
    TemplatePicker.tsx    — carousel of template previews for selected occasion
    FestivalForm.tsx      — offer text, CTA, language, include reel toggle
    CreditEstimate.tsx    — shows "This will use X credits" before confirming
```

The existing `GenerationProgress` SSE component is reused unchanged for the
progress bar after submission.

### Updated pages

The campaign detail page gets a new "Festival Campaign" button alongside the
existing "New Post" button.

---

## 7. Content worker changes

### TEMPLATE_SELECT stage handler (new)

```typescript
// libs/ai/src/festival/template-selector.ts
async selectTemplate(occasion: string, brand: BrandContext, availableTemplates: Template[]): Promise<string> {
  if (availableTemplates.length === 1) return availableTemplates[0].id;
  // Use LLM to pick based on brand voice and template descriptions
  const prompt = buildTemplateSelectorPrompt(brand, availableTemplates);
  const result = await this.llm.complete(prompt, { schema: templateSelectionSchema });
  return result.selectedTemplateId;
}
```

### COPY_FILL stage handler (new)

```typescript
// libs/ai/src/festival/copy-filler.ts
async fillSlots(template: Template, brand: BrandContext, input: FestivalInput): Promise<FilledSlots> {
  const prompt = buildCopyFillPrompt(template.slots, brand, input);
  const result = await this.llm.complete(prompt, { schema: filledSlotsSchema(template.slots) });
  // Validate each slot against maxChars
  validateSlots(result, template.slots); // throws on failure → retry with repair prompt
  return result;
}
```

Both implement the existing `StageHandler` interface — no changes to the worker runner.

---

## 8. Media worker changes

### IMAGE_RENDER stage handler (new)

```typescript
// apps/media-worker/src/handlers/festival-image.handler.ts
async handle(job: GenerationJob, checkpoint: JobCheckpoint): Promise<void> {
  const { templateId, filledSlots } = checkpoint.copyFill;
  const template = await loadTemplate(templateId);      // from S3
  const brandLogo = await loadAsset(job.brand.logoAssetId); // from S3

  // Use sharp to composite:
  // 1. Template background image
  // 2. Brand logo at defined position
  // 3. Text overlays for each filled slot (using brand fonts + colors)
  const poster = await compositeTemplate(template, filledSlots, brandLogo);

  const s3Key = `jobs/${job.id}/poster.png`;
  await storage.put(s3Key, poster);
  await saveCheckpoint(job.id, 'IMAGE_RENDER', { s3Key });
}
```

### REEL_RENDER stage handler (new)

Uses FFmpeg (already available in `media-worker`):

```
Input:  poster.png (from IMAGE_RENDER checkpoint)
        bgm.mp3 (from template)
Effect: Ken Burns pan/zoom on poster
Overlay: brand name text at bottom, fade in at 2s
Output: 15s MP4 at 1080x1080, H.264, AAC audio
```

---

## 9. Mock provider changes

Add festival-specific mock implementations:

```typescript
// libs/ai/src/festival/mock-template-selector.ts
→ always returns availableTemplates[0].id

// libs/ai/src/festival/mock-copy-filler.ts
→ returns hardcoded filled slots with brand name injected
→ supports FAIL_STAGE=COPY_FILL for chaos testing

// apps/media-worker/src/handlers/mock-festival-image.handler.ts
→ returns a solid color PNG with brand primaryColor and offer text overlay
→ fast, deterministic, no external dependency
```

---

## 10. Seeding for demo

Add to `pnpm db:seed`:

```typescript
// seeds festival_occasions
await db.insert(festivalOccasions).values([
  { id: 'DIWALI',          displayName: 'Diwali',           iconUrl: '...' },
  { id: 'CHRISTMAS',       displayName: 'Christmas',        iconUrl: '...' },
  { id: 'NEW_YEAR',        displayName: 'New Year',         iconUrl: '...' },
  { id: 'INDEPENDENCE_DAY',displayName: 'Independence Day', iconUrl: '...' },
]);

// seeds festival_templates (one per occasion for v1)
await db.insert(festivalTemplates).values([...]);

// seeds demo account with a pre-created brand
await seedDemoBrand({
  email: 'demo@renderflow.dev',
  password: 'Demo1234!',
  brandName: 'Denny\'s Bakery',
  primaryColor: '#E67E22',
  tagline: 'Fresh baked every morning',
});
```

---

## 11. Phase plan

This feature is **Phase 11** of RenderFlow (after the existing 0–10 phases).

| Step      | Task                                                          | Effort        |
| --------- | ------------------------------------------------------------- | ------------- |
| 11.1      | DB migration: `festival_occasions`, `festival_templates`      | 1h            |
| 11.2      | Seed: occasions + templates + demo brand                      | 1h            |
| 11.3      | Stage machine: add FESTIVAL_IMAGE, FESTIVAL_REEL kinds        | 1h            |
| 11.4      | API endpoints: GET /occasions, GET /templates, POST /festival | 3h            |
| 11.5      | Content worker: TEMPLATE_SELECT + COPY_FILL handlers          | 4h            |
| 11.6      | Media worker: IMAGE_RENDER (sharp composite)                  | 4h            |
| 11.7      | Media worker: REEL_RENDER (FFmpeg)                            | 3h            |
| 11.8      | Mock providers for all new handlers                           | 2h            |
| 11.9      | Frontend: occasion gallery + template picker + form           | 5h            |
| 11.10     | Integration tests: full FESTIVAL pipeline with mocks          | 3h            |
| 11.11     | E2E test: festival journey in Playwright                      | 2h            |
| **Total** |                                                               | **~29 hours** |

---

## 12. What this adds to the portfolio / interview story

> "I added a festival marketing generator on top of the existing pipeline.
> I didn't add new workers or new queues — I extended the stage machine with
> two new job kinds (FESTIVAL_IMAGE and FESTIVAL_REEL) that map to existing
> workers. The template system uses a JSON slot descriptor that the LLM fills,
> then sharp composites into a poster, then FFmpeg turns into a reel. The credit
> system handles it automatically because the new generation kind produces
> checkpoints that the existing runner settles."
