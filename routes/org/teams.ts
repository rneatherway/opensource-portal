//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
const router = express.Router();

import { ReposAppRequest } from '../../transitional';
import { popSessionVariable } from '../../utils';
const lowercaser = require('../../middleware/lowercaser');

import RouteTeam from './team/';

interface ITeamsRequest extends ReposAppRequest {
  team2?: any;
  teamUrl?: any;
}

router.use(function (req: ReposAppRequest, res, next) {
  req.individualContext.webContext.pushBreadcrumb('Teams');
  req.reposContext = {
    section: 'teams',
    organization: req.organization,
  };
  next();
});

router.get('/', function (req, res, next) {
  const beforeLinkReferrer = popSessionVariable(req, res, 'beforeLinkReferrer');
  if (beforeLinkReferrer !== undefined) {
    return res.redirect(beforeLinkReferrer);
  }
  return next();
});

router.get('/', lowercaser(['sort', 'set']), require('../teamsPager'));

router.use('/:teamSlug', asyncHandler(async (req: ITeamsRequest, res, next) => {
  const organization = req.organization;
  const orgBaseUrl = organization.baseUrl;
  const slug = req.params.teamSlug as string;
  try {
    const team = await organization.getTeamFromName(slug);
    req.team2 = team;
    // Breadcrumb and path updates
    req.teamUrl = `${orgBaseUrl}teams/${team.slug}/`;
    req.individualContext.webContext.pushBreadcrumb(team.name);
    return next();
  } catch (getTeamError) {
    if (getTeamError && getTeamError.slug) {
    // Redirect if a name was provided when a slug is more appropriate
    return res.redirect(`${orgBaseUrl}teams/${getTeamError.slug}`);
    }
    if (getTeamError) {
      return next(getTeamError);
    }
  }
}));

router.use('/:teamname', RouteTeam);

export default router;
