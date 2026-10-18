'use strict';

const { validatePackage } = require('./release-utils.cjs');

// This hook also protects builds launched directly through electron-builder.
module.exports = async (context) => { validatePackage(context.packager.info.appDir); };
