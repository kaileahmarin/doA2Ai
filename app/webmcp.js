export class BoundedToolRegistry {
  #definitions = new Map();
  #invocations = new Set();
  #listeners = new Set();

  setDefinitions(definitions) {
    for (const controller of this.#invocations) controller.abort();
    this.#invocations.clear();
    this.#definitions = new Map(definitions.map((definition) => [definition.name, definition]));
    const snapshot = this.list();
    for (const listener of this.#listeners) listener(snapshot);
  }

  list() {
    return [...this.#definitions.values()].map(({ execute, ...metadata }) => structuredClone(metadata));
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async invoke(name, input) {
    const definition = this.#definitions.get(name);
    if (!definition) {
      const error = new Error(`Tool ${name} is not exposed in the current task state.`);
      error.code = "TOOL_NOT_EXPOSED";
      throw error;
    }
    const controller = new AbortController();
    this.#invocations.add(controller);
    try {
      return await definition.execute(structuredClone(input), { signal: controller.signal });
    } finally {
      this.#invocations.delete(controller);
    }
  }
}

export class WebMcpBridge {
  #modelContext;
  #controllers = [];
  #generation = 0;
  #lastError = null;

  constructor(modelContext = globalThis.document?.modelContext ?? null) {
    this.#modelContext = modelContext;
  }

  get supported() {
    return Boolean(this.#modelContext?.registerTool);
  }

  get lastError() {
    return this.#lastError;
  }

  async sync(definitions) {
    const generation = ++this.#generation;
    for (const controller of this.#controllers) controller.abort();
    const controllers = [];
    this.#controllers = controllers;
    this.#lastError = null;

    if (!this.supported) return { supported: false, registered: [] };

    const registered = [];
    try {
      for (const definition of definitions) {
        if (generation !== this.#generation) break;
        const controller = new AbortController();
        controllers.push(controller);
        await this.#modelContext.registerTool(definition, { signal: controller.signal });
        if (generation !== this.#generation) break;
        registered.push(definition.name);
      }
      if (generation !== this.#generation) {
        for (const controller of controllers) controller.abort();
        return { supported: true, registered: [] };
      }
      return { supported: true, registered };
    } catch (error) {
      for (const controller of controllers) controller.abort();
      if (generation !== this.#generation) return { supported: true, registered: [] };
      this.#lastError = error;
      if (this.#controllers === controllers) this.#controllers = [];
      return { supported: true, registered: [], error };
    }
  }

  dispose() {
    this.#generation += 1;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers = [];
  }
}
