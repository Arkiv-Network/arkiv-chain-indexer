# Advanced Data Modeling Patterns

Patterns for handling type safety and complex relationships in Arkiv.

## Table of Contents

1. [Validate Entity Data with a Schema Library](#validate-entity-data-with-a-schema-library)
2. [Model Lists with Relationship Entities](#model-lists-with-relationship-entities)

---

## Validate Entity Data with a Schema Library

`entity.toJson()` returns `any` in TypeScript — no type safety. Always validate the shape of data you read from Arkiv using a schema validation library (e.g., `zod`, `valibot`, `yup`). Before adding a new library, check if the project already uses one.

```typescript
import { z } from "zod"; // or use whatever validation library the project already has

const PostSchema = z.object({
  title: z.string(),
  content: z.string(),
  author: z.string().optional(),
});

type Post = z.infer<typeof PostSchema>;

// Safe parsing — never trust raw entity data
function parsePost(entity: any): Post {
  const raw = entity.toJson();
  const result = PostSchema.safeParse(raw);
  if (!result.success) {
    console.error("Invalid entity data:", result.error.flatten());
    throw new Error("Entity data does not match expected schema");
  }
  return result.data;
}

// Usage in queries
const result = await publicClient
  .buildQuery()
  .where([
    eq(PROJECT_ATTRIBUTE.key, PROJECT_ATTRIBUTE.value),
    eq("entityType", "post"),
  ])
  .withPayload(true)
  .fetch();

const posts: Post[] = result.entities
  .map((e) => {
    try {
      return parsePost(e);
    } catch {
      return null;
    }
  })
  .filter((p): p is Post => p !== null);
```

This protects against:

- Other projects accidentally writing to your attribute namespace
- Data format changes between versions
- Corrupted or malformed payloads

---

## Model Lists with Relationship Entities

Arkiv attributes are flat key-value pairs — there is no native array type. A common mistake is trying to encode lists into attributes:

```typescript
// BAD — indexed attributes. Can't query "all profiles with skill frontend"
attributes: [
  { key: "skills_0", value: "frontend" },
  { key: "skills_1", value: "backend" },
  { key: "skills_2", value: "devops" },
]

// BAD — comma-separated string. Can't query individual skills
attributes: [
  { key: "skills", value: "frontend, backend, devops" },
]
```

Both approaches break querying. You can't efficiently find "all profiles that have the `frontend` skill" without fetching everything and filtering client-side.

**The correct pattern:** Create separate **relationship entities** that link the parent entity to each value. This is the relational model — one entity per relationship:

```typescript
// 1. Create the profile entity
const { entityKey: profileKey } = await walletClient.createEntity({
  payload: jsonToPayload({ name: "Alice", bio: "Full-stack dev" }),
  contentType: "application/json",
  attributes: [
    PROJECT_ATTRIBUTE,
    { key: "entityType", value: "profile" },
    { key: "profileId", value: "alice-123" },
  ],
  expiresIn: ExpirationTime.fromDays(30),
});

// 2. Create one relationship entity per skill
const skills = ["frontend", "backend", "devops"];
await walletClient.mutateEntities({
  creates: skills.map((skill) => ({
    payload: jsonToPayload({ profileId: "alice-123", skill }),
    contentType: "application/json",
    attributes: [
      PROJECT_ATTRIBUTE,
      { key: "entityType", value: "profileSkill" },
      { key: "profileId", value: "alice-123" },
      { key: "skill", value: skill },
    ],
    expiresIn: ExpirationTime.fromDays(30),
  })),
});

// 3. Query all profiles with "frontend" skill — fast and indexed
const frontendDevs = await publicClient.buildQuery()
  .where([
    eq(PROJECT_ATTRIBUTE.key, PROJECT_ATTRIBUTE.value),
    eq("entityType", "profileSkill"),
    eq("skill", "frontend"),
  ])
  .withPayload(true)
  .fetch();

// 4. Query all skills for a specific profile
const aliceSkills = await publicClient.buildQuery()
  .where([
    eq(PROJECT_ATTRIBUTE.key, PROJECT_ATTRIBUTE.value),
    eq("entityType", "profileSkill"),
    eq("profileId", "alice-123"),
  ])
  .withPayload(true)
  .fetch();
```

This pattern applies to any one-to-many or many-to-many relationship: tags, categories, permissions, memberships, etc.
