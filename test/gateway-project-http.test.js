import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { routeGatewayRequest } from "../src/gateway/server.js";

test("Gateway HTTP 暴露 Project Catalog 并把 projectId 传给新 Session", async (t) => {
  const calls = [];
  const manager = {
    listProjects: async () => ({
      defaultProjectId: "project-default",
      root: "/tmp/projects",
      projects: [{ id: "project-default", name: "默认工作区" }],
    }),
    createProject: async ({ name }) => ({ id: "project-new", name }),
    runtimeInfo: async (projectId) => ({ projectId }),
    list: async (projectId) => {
      calls.push(["list", projectId]);
      return [];
    },
    create: async (input) => {
      calls.push(["create", input]);
      return { id: "session-new", workspace: "/tmp/projects/New", project: { id: input.projectId } };
    },
    close: async () => {},
  };
  const projects = await request(manager, "GET", "/projects");
  assert.equal(projects.defaultProjectId, "project-default");

  const createdProject = await request(manager, "POST", "/projects", { name: "New" });
  assert.deepEqual(createdProject.project, { id: "project-new", name: "New" });

  await request(manager, "GET", "/sessions?projectId=project-new");
  const createdSession = await request(manager, "POST", "/sessions", {
    projectId: "project-new",
    agentProfileId: "coding",
  });
  assert.equal(createdSession.session.project.id, "project-new");
  assert.deepEqual(calls, [
    ["list", "project-new"],
    ["create", {
      resume: undefined,
      projectId: "project-new",
      agentProfileId: "coding",
      permissionProfile: undefined,
      permissionConfirmation: undefined,
    }],
  ]);
});

async function request(manager, method, url, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const request = Readable.from(payload ? [Buffer.from(payload)] : []);
  request.method = method;
  request.url = url;
  request.headers = payload ? { "content-type": "application/json" } : {};
  const response = {
    headersSent: false,
    status: null,
    body: "",
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(value = "") {
      this.body += String(value);
    },
  };
  await routeGatewayRequest(request, response, manager);
  assert.ok(response.status >= 200 && response.status < 300, response.body);
  return JSON.parse(response.body);
}
