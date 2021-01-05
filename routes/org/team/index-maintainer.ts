//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import express from 'express';

import { ReposAppRequest } from '../../../transitional';
import { wrapError } from '../../../utils';
const router = express.Router();

import RouteApprovals from './approvals';

const membersRoute = require('./members');

interface ILocalRequest extends ReposAppRequest {
  teamPermissions?: any;
}

router.use(function (req: ILocalRequest, res, next) {
  const teamPermissions = req.teamPermissions;
  if (!teamPermissions.allowAdministration) {
    const err = wrapError(null, 'You do not have permission to maintain this team.', true);
    err.detailed = 'These aren\'t the droids you are looking for.';
    err.status = 403;
    err.skipLog = true;
    return next(err);
  }

  return next();
});

router.use('/approvals', RouteApprovals);
router.use('/members', membersRoute);

export default router;
