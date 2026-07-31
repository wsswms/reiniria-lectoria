export class ResourceNotFoundError extends Error {
  constructor() {
    super("resource not found");
    this.name = "ResourceNotFoundError";
    this.code = "RESOURCE_NOT_FOUND";
  }
}

export class InvalidWorkspacePathError extends Error {
  constructor() {
    super("invalid workspace path");
    this.name = "InvalidWorkspacePathError";
    this.code = "INVALID_WORKSPACE_PATH";
  }
}
