# Workspaces and access keys

Every protected SHAPI resource belongs to a workspace. Web and Runner clients
use separate, random credentials; the Hub stores only SHA-256 token hashes.

## Credential types

- **Web key**: signs in to the PWA and manages the workspace.
- **Runner key**: connects a Runner and may call CLI endpoints. It cannot sign
  in to the PWA.
- **Legacy key**: temporary migration credential for an existing namespace.

Tokens are returned only when created. Copy them immediately.
New Web keys start with `spw`; new Runner keys start with `spr`. The prefix is
part of the token and contains no underscore.

## API

All management calls require a Web JWT from `POST /api/auth`.

```text
GET    /api/workspaces/current
POST   /api/workspaces
POST   /api/workspaces/current/access-keys
DELETE /api/workspaces/current/access-keys/:id
```

Create a workspace:

```json
{ "name": "Production" }
```

The response contains one Web key and one Runner key. Configure each client
with its matching key. Creating another key accepts:

```json
{ "kind": "runner", "name": "Mac mini", "expiresInDays": 365 }
```

Revoking a key prevents new authentication. Web JWTs issued for a revoked key
are also rejected on subsequent API requests.

## Migration

On startup, SHAPI registers workspaces for every existing data namespace. The
old base token (for `default`) and old suffixed tokens (for known namespaces)
continue to authenticate as legacy keys. Unknown suffixes are rejected.

Recommended migration:

1. Sign in once with the existing credential.
2. Issue a Web key and a Runner key.
3. Update the PWA and Runner credentials.
4. Sign in with the new Web key.
5. Revoke the legacy access key.

The data tables continue using their existing namespace values internally as a
compatibility adapter. Authorization is based on workspace ID and credential,
not on a client-selected namespace.
