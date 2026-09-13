export class AnakinError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Our own hourly spending limit, not something Anakin said.
export class OverBudget extends Error {
  constructor(used, cap, want) {
    super(`hourly Anakin credit cap reached: ${used} of ${cap} credits used in the last hour, this call needs ${want} more`);
    this.used = used;
    this.cap = cap;
  }
}
