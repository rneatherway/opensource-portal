//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import { jsonError } from '../../../../middleware/jsonError';
import { IProviders, ReposAppRequest } from '../../../../transitional';
import { asNumber } from '../../../../utils';
import { Organization } from '../../../../business/organization';
import { MemberSearch } from '../../../../business/memberSearch';
import { Operations } from '../../../../business/operations';
import { corporateLinkToJson } from '../../../../business/corporateLink';
import { OrganizationMember } from '../../../../business/organizationMember';
import LeakyLocalCache, { getLinksLightCache, leakyLocalCacheLinks } from '../leakyLocalCache';
import { Team } from '../../../../business/team';
import { TeamMember } from '../../../../business/teamMember';
import JsonPager from '../jsonPager';

const router = express.Router();

// BAD PRACTICE: leaky local cache
// CONSIDER: use a better approach
const leakyLocalCacheOrganizationMembers = new LeakyLocalCache<string, OrganizationMember[]>();
const leakyLocalCacheTeamMembers = new LeakyLocalCache<string, TeamMember[]>();

async function getTeamMembers(options?: PeopleSearchOptions) {
  if (!options?.team) {
    return;
  }
  if (!options.forceRefresh) {
    const value = leakyLocalCacheTeamMembers.get(options.team.slug);
    if (value) {
      return value;
    }
  }
  const refreshOptions = options.forceRefresh ? { backgroundRefresh: false, maxAgeSeconds: -1 } : undefined;
  const teamMembers = await options.team.getMembers(refreshOptions);
  leakyLocalCacheTeamMembers.set(options.team.slug, teamMembers);
  return teamMembers;
}

async function getPeopleForOrganization(operations: Operations, org: string, options?: PeopleSearchOptions) {
  const teamMembers = await getTeamMembers(options);
  const value = leakyLocalCacheOrganizationMembers.get(org);
  if (value) {
    return { organizationMembers: value, teamMembers };
  }
  const organization = operations.getOrganization(org);
  const organizationMembers = await organization.getMembers();
  leakyLocalCacheOrganizationMembers.set(org, organizationMembers);
  return { organizationMembers, teamMembers };
}

type PeopleSearchOptions = {
  team: Team;
  forceRefresh: boolean;
}

export async function equivalentLegacyPeopleSearch(req: ReposAppRequest, options?: PeopleSearchOptions) {
  const { operations } = req.app.settings.providers as IProviders;
  const links = await getLinksLightCache(operations);
  const org = req.organization ? req.organization.name : null;
  const orgId = req.organization ? (req.organization as Organization).id : null;
  const { organizationMembers, teamMembers } = await getPeopleForOrganization(operations, org, options);
  const page = req.query.page_number ? Number(req.query.page_number) : 1;
  let phrase = req.query.q as string;
  let type = req.query.type as string;
  const validTypes = new Set([
    'linked',
    'active',
    'unlinked',
    'former',
    'serviceAccount',
    'unknownAccount',
    'owners',
  ]);
  if (!validTypes.has(type)) {
    type = null;
  }
  const filters = [];
  if (type) {
    filters.push({
      type: 'type',
      value: type,
      displayValue: type === 'former' ? 'formerly known' : type,
      displaySuffix: 'members',
    });
  }
  if (phrase) {
    filters.push({
      type: 'phrase',
      value: phrase,
      displayPrefix: 'matching',
    });
  }
  const search = new MemberSearch({
    phrase,
    type,
    pageSize: 1000000, // temporary, just return it all, we'll slice it locally
    links,
    providers: operations.providers,
    orgId,
    organizationMembers,
    // crossOrganizationMembers,
    // isOrganizationScoped: !!org, // Whether this view is specific to an org or not
    isOrganizationScoped: true,
    // team2AddType: null, // req.team2AddType, // Used to enable the "add a member" or maintainer experience for teams
    teamMembers, // Used to filter team members in ./org/ORG/team/TEAM/members and other views
  });
  await search.search(page, req.query.sort as string);
  return search;
}

router.get('/', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const pager = new JsonPager<OrganizationMember>(req, res);
  try {
    const searcher = await equivalentLegacyPeopleSearch(req);
    const members = searcher.members;
    const slice = pager.slice(members);
    return pager.sendJson(slice.map(organizationMember => {
        const obj = Object.assign({
          link: organizationMember.link ? corporateLinkToJson(organizationMember.link) : null,
        }, organizationMember.getEntity());
        return obj;
      }),
    );
  } catch (repoError) {
    console.dir(repoError);
    return next(jsonError(repoError));
  }
}));

router.use('*', (req, res, next) => {
  return next(jsonError('no API or function available within this people list', 404));
});

export default router;
