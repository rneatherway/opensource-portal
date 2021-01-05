//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
import { corporateLinkToJson, ICorporateLink } from '../../../../business/corporateLink';
import { OrganizationMember } from '../../../../business/organizationMember';
import { Repository } from '../../../../business/repository';
import { GitHubRepositoryType, TeamJsonFormat } from '../../../../business/team';
import { TeamMember } from '../../../../business/teamMember';
import { TeamRepositoryPermission } from '../../../../business/teamRepositoryPermission';
import { getContextualTeam } from '../../../../middleware/github/teamPermissions';

import { jsonError } from '../../../../middleware/jsonError';
import { sortRepositoriesByNameCaseInsensitive } from '../../../../routes/org/team';
import { IProviders, ReposAppRequest } from '../../../../transitional';
import { asNumber } from '../../../../utils';
import JsonPager from '../jsonPager';
import { getLinksLightCache } from '../leakyLocalCache';
import { equivalentLegacyPeopleSearch } from './people';

const router = express.Router();

router.get('/', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const team = getContextualTeam(req);
  return res.json(team.asJson(TeamJsonFormat.Augmented /* includes corporateMetadata */));
}));

router.get('/repos', asyncHandler(async (req: ReposAppRequest, res, next) => {
  try {
    const forceRefresh = !!req.query.refresh;
    const pager = new JsonPager<TeamRepositoryPermission>(req, res);
    const team = getContextualTeam(req);
    // const onlySourceRepositories = {
    //   type: GitHubRepositoryType.,
    // };
    let reposWithPermissions = null;
    const cacheOptions = forceRefresh ? {
      backgroundRefresh: false,
      maxAgeSeconds: -1,
    } : undefined;
    reposWithPermissions = await team.getRepositories(cacheOptions);
    const repositories = reposWithPermissions.sort(sortRepositoriesByNameCaseInsensitive);
    const slice = pager.slice(repositories);
    return pager.sendJson(slice.map(rp => {
      return rp.asJson();
    }));
  } catch (repoError) {
    console.dir(repoError);
    return next(jsonError(repoError));
  }
}));

router.get('/members', asyncHandler(async (req: ReposAppRequest, res, next) => {
  try {
    const forceRefresh = !!req.query.refresh;
    const team = getContextualTeam(req);
    const pager = new JsonPager<OrganizationMember>(req, res); // or Org Member?
    const searcher = await equivalentLegacyPeopleSearch(req, { team, forceRefresh });
    const members = searcher.members;
    const slice = pager.slice(members);
    return pager.sendJson(slice.map(organizationMember => {
      const obj = Object.assign({
        link: organizationMember.link ? corporateLinkToJson(organizationMember.link) : null,
      }, organizationMember.getEntity());
      return obj;
    }));
  } catch (error) {
    console.dir(error);
    return next(jsonError(error));
  }
}));

router.get('/maintainers', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { operations } = req.app.settings.providers as IProviders;
  try {
    const forceRefresh = !!req.query.refresh;
    const team = getContextualTeam(req);
    const links = await getLinksLightCache(operations);
    const cacheOptions = forceRefresh ? {
      backgroundRefresh: false,
      maxAgeSeconds: -1,
    } : undefined;
    const maintainers = await team.getMaintainers(cacheOptions);
    const idSet = new Set<number>();
    maintainers.forEach(maintainer => idSet.add(Number(maintainer.id)));
    const ls = new Map<number, ICorporateLink>();
    links.forEach(link => {
      if (idSet.has(Number(link.thirdPartyId))) {
        ls.set(Number(link.thirdPartyId), link);
      }
    });
    return res.json(maintainers.map(maintainer => {
      return {
        member: maintainer.asJson(),
        isSystemAccount: operations.isSystemAccountByUsername(maintainer.login),
        link: corporateLinkToJson(ls.get(Number(maintainer.id))),
      };
    }));
  } catch (error) {
    return next(error);
  }
}));

router.use('*', (req, res, next) => {
  return next(jsonError('no API or function available for this specific team', 404));
});

export default router;
