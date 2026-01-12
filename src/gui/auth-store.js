#!/usr/bin/env node
'use strict';

function removed() {
  throw new Error('GUI removed: auth-store is no longer available.');
}

module.exports = {
  setUserPassword: async () => removed(),
  verifyUserPassword: async () => removed(),
  hasUser: async () => removed(),
  fallbackAuthPath: null,
};
