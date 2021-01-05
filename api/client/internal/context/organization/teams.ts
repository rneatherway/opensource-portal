
//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
import { Team } from '../../../../../business/team';
import { setContextualTeam } from '../../../../../middleware/github/teamPermissions';

import { jsonError } from '../../../../../middleware/jsonError';
import { ReposAppRequest } from '../../../../../transitional';

import RouteTeam from './team';

const router = express.Router();

// CONSIDER: list their teams router.get('/ ')

router.use('/:teamSlug', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { organization } = req;
  const { teamSlug } = req.params;
  let team: Team = null;
  try {
    team = await organization.getTeamFromSlug(teamSlug);
    setContextualTeam(req, team);
  } catch (error) {
    console.dir(error);
    return next(error);
  }
  return next();
}));

router.use('/:teamSlug', RouteTeam);

router.use('*', (req, res, next) => {
  return next(jsonError('no API or function available for repos', 404));
});

export default router;
