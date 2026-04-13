import type { AxiosInstance } from "axios";
import type winston from "winston";

export const BITBUCKET_DEFAULT_PAGELEN = 25;
export const BITBUCKET_MAX_PAGELEN = 100;
export const BITBUCKET_ALL_ITEMS_CAP = 1000;

export interface PaginationRequestOptions {
  pagelen?: number;
  page?: number;
  all?: boolean;
  params?: Record<string, any>;
  defaultPagelen?: number;
  maxItems?: number;
  description?: string;
}

export interface PaginatedValuesResult<T> {
  values: T[];
  page?: number;
  pagelen: number;
  next?: string;
  fetchedPages: number;
  totalFetched: number;
  previous?: string;
  isLastPage?: boolean;
  nextPageStart?: number;
}

interface PendingRequestConfig {
  url: string;
  params?: Record<string, any>;
}

export class BitbucketPaginator {
  constructor(
    private readonly api: AxiosInstance,
    private readonly logger: winston.Logger
  ) {}

  async fetchValues<T>(
    path: string,
    options: PaginationRequestOptions = {}
  ): Promise<PaginatedValuesResult<T>> {
    const {
      pagelen,
      page,
      all = false,
      params = {},
      defaultPagelen = BITBUCKET_DEFAULT_PAGELEN,
      maxItems = BITBUCKET_ALL_ITEMS_CAP,
      description,
    } = options;

    const resolvedLimit = this.normalizePagelen(pagelen ?? defaultPagelen);

    // Bitbucket Server uses `limit` and `start` (0-based offset) instead of `pagelen`/`page`
    const startOffset =
      page !== undefined ? (page - 1) * resolvedLimit : 0;

    const requestParams: Record<string, any> = {
      ...params,
      limit: resolvedLimit,
    };
    if (page !== undefined) {
      requestParams.start = startOffset;
    }

    const shouldFetchAll = all === true && page === undefined;
    const requestDescriptor: PendingRequestConfig = {
      url: path,
      params: requestParams,
    };

    if (!shouldFetchAll) {
      const response = await this.performRequest(
        requestDescriptor,
        description
      );
      const values = this.extractValues<T>(response.data);
      return {
        values,
        page: page ?? 1,
        pagelen: response.data?.limit ?? resolvedLimit,
        fetchedPages: 1,
        totalFetched: values.length,
        isLastPage: response.data?.isLastPage ?? true,
        nextPageStart: response.data?.nextPageStart,
      };
    }

    // Fetch all pages using Bitbucket Server's isLastPage / nextPageStart
    const aggregated: T[] = [];
    let fetchedPages = 0;
    let currentStart = 0;
    let firstPageMeta: { pagelen: number } = { pagelen: resolvedLimit };

    while (aggregated.length < maxItems) {
      const currentParams: Record<string, any> = {
        ...params,
        limit: resolvedLimit,
        start: currentStart,
      };

      const currentRequest: PendingRequestConfig = {
        url: path,
        params: currentParams,
      };

      const response = await this.performRequest(currentRequest, description, {
        page: fetchedPages + 1,
      });
      fetchedPages += 1;

      if (fetchedPages === 1) {
        firstPageMeta = {
          pagelen: response.data?.limit ?? resolvedLimit,
        };
      }

      const values = this.extractValues<T>(response.data);
      aggregated.push(...values);

      // isLastPage === false means there are more pages; anything else (true or missing) means done
      if (response.data?.isLastPage !== false) {
        break;
      }

      if (aggregated.length >= maxItems) {
        this.logger.debug("Bitbucket pagination cap reached", {
          description: description ?? path,
          maxItems,
        });
        break;
      }

      const nextStart = response.data?.nextPageStart;
      if (nextStart === undefined || nextStart === null) {
        break;
      }

      this.logger.debug("Following Bitbucket Server pagination", {
        description: description ?? path,
        nextPageStart: nextStart,
        fetchedPages,
        totalFetched: aggregated.length,
      });

      currentStart = nextStart;
    }

    if (aggregated.length > maxItems) {
      aggregated.length = maxItems;
    }

    return {
      values: aggregated,
      page: 1,
      pagelen: firstPageMeta.pagelen,
      fetchedPages,
      totalFetched: aggregated.length,
      isLastPage: true,
    };
  }

  private async performRequest(
    request: PendingRequestConfig,
    description?: string,
    extra?: Record<string, any>
  ) {
    this.logger.debug("Calling Bitbucket API", {
      description: description ?? request.url,
      url: request.url,
      params: request.params,
      ...extra,
    });
    const config = request.params ? { params: request.params } : undefined;
    return this.api.get(request.url, config);
  }

  private extractValues<T>(data: any): T[] {
    if (Array.isArray(data?.values)) {
      return data.values as T[];
    }
    if (Array.isArray(data)) {
      return data as T[];
    }
    return [];
  }

  private normalizePagelen(value?: number): number {
    if (value === undefined || Number.isNaN(value)) {
      return BITBUCKET_DEFAULT_PAGELEN;
    }
    const integer = Math.floor(value);
    if (!Number.isFinite(integer) || integer < 1) {
      return 1;
    }
    return Math.min(integer, BITBUCKET_MAX_PAGELEN);
  }
}
