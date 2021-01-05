//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
import { getServiceTreeClient, getServiceTreeServicesCache, IServiceTreeServiceSubset } from '../../../microsoft/serviceTree';

import { jsonError } from '../../../middleware/jsonError';
import { IProviders, ReposAppRequest } from '../../../transitional';

const router = express.Router();

const CacheMinutes = 60 * 24; // 1 day

router.get('/servicesSearch', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const providers = req.app.settings.providers as IProviders;
  const cache = getServiceTreeServicesCache(providers);
  const services = await cache.tryGetServices();
  const q = ((req.query.q as string) || '').trim().toLowerCase();
  const maxResults = 80;
  const results = services.filter(filterServices.bind(null, q)).slice(0, maxResults);
  return res.json({
    services: results,
  });
}));

function filterServices(queryLowercase: string, service: IServiceTreeServiceSubset) {
  const combi = `${service.Name} ${service.ShortName} ${service.Id} ${service.OrganizationPath} ${service.Description}`.toLowerCase();
  return combi.includes(queryLowercase);
}

// router.get('/', asyncHandler(async (req: ReposAppRequest, res, next) => {
//   const providers = req.app.settings.providers as IProviders;
//   const serviceTreeClient = getServiceTreeClient(providers);
//   try {
//     return res.json(await serviceTreeClient.callServiceTree('Services(553e512b-99b2-45b8-90d0-e0a07fad0b4a)'));
//   } catch (error) {
//     console.log(error);
//     throw jsonError(error);
//   }
// }));

router.get('/*', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const providers = req.app.settings.providers as IProviders;
  const serviceTreeClient = getServiceTreeClient(providers);
  const { path } = req as { path: string };
  const moniker = path;
  let remainder = '';
  let i = req.originalUrl.indexOf(moniker);
  let url = path;
  if (i >= 0 && req.query) {
    remainder = req.originalUrl.substr(i + moniker.length);
    url = path + remainder;
  }
  try {
    const cacheKey = `servicetree:cache:${url}`;
    const cachedResponse = await providers.cacheProvider.getObjectCompressed(cacheKey);
    if (cachedResponse) {
      return res.json(cachedResponse);
    }
    const response = await serviceTreeClient.callServiceTree(url);
    providers.cacheProvider.setObjectCompressedWithExpire(cacheKey, response, CacheMinutes);
    return res.json(response);
  } catch (error) {
    console.log(error);
    throw jsonError(error);
  }
}));

export default router;
