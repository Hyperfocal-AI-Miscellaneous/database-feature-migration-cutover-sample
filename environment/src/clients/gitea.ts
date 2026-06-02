import { GITEA_IP, GITEA_ADMIN_USER, GITEA_ADMIN_PASS } from "../config.js";
import { httpGet, type HttpResponse } from "./http.js";

export async function giteaApiGet(path: string): Promise<HttpResponse> {
  return httpGet(giteaApiUrl(path), {
    headers: { Authorization: basicAuthHeader() },
  });
}

function giteaApiUrl(path: string): string {
  return `http://${GITEA_IP}:3000/api/v1${path}`;
}

function basicAuthHeader(): string {
  const creds = `${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}`;
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}
