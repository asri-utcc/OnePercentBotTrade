'use strict';

const EventEmitter = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // รองรับ dashboard clients หลายตัว
  }
}

module.exports = new EventBus();