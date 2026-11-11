# Hosting dap.xadi.eu

The app runs under pm2 (`dap-xadi-eu`, port 3002) on 88.198.112.206 (Hetzner, user `ploi`), from
`/home/ploi/dap.xadi.eu`. These files are the source of truth; the server runs installed copies:

| File | Installed at | Installed by |
|------|--------------|--------------|
| `deploy.sh` | `/home/ploi/deploy/dap-xadi-eu/deploy.sh` | `ploi` (`scp`, then `chmod 700`) |
| `nginx.conf` | `/etc/nginx/sites-available/dap.xadi.eu` | root, then `nginx -t && systemctl reload nginx` |

`nginx.conf` is still Ploi's template: the `include /etc/nginx/ploi/...` lines and the TLS include are part of it.

## How a deploy happens

A push to `main` sends a GitHub webhook to `https://dap.xadi.eu/_deploy/github`. nginx proxies it to the server's
shared `webhook` daemon (pm2 `deploy-webhook`, hooks in `/home/ploi/deploy/hooks.json`, hook id `dap-xadi-eu`). The
daemon checks the signature, event, branch and repo, then runs `/home/ploi/deploy/run.sh dap-xadi-eu`.

`deploy.sh`:
1. Fast-forwards the checkout.
2. Skips if that revision is already live. `--force` deploys anyway.
3. Runs `npm ci --omit=dev`, restarts the pm2 app, and waits for `/health`.
4. If anything fails, rolls back to the previous revision.

Output goes to `/home/ploi/deploy/dap-xadi-eu/deploy.log`. The repo is public, so the server fetches over plain https
with no credentials.
