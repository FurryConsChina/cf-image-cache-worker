import { env } from 'cloudflare:workers';

const UPSTREAM_URL = env.UPSTREAM_URL;

const WHITELISTED_PATHS = ['/assets/', '/banner', '/fec-event', '/logo', '/organizations/'];

const imageContentTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/avif', 'image/tiff', 'image/svg+xml'];

async function fetchFromUpstream(request: Request<unknown, IncomingRequestCfProperties<unknown>>, filteredSearchParams: URLSearchParams) {
	const originalUrl = new URL(request.url);
	const upstreamBaseUrl = new URL(UPSTREAM_URL);

	// 创建新的 URL 对象用于上游请求
	const upstreamUrl = new URL(originalUrl.pathname, upstreamBaseUrl); // 使用上游基础 URL 和原始路径
	upstreamUrl.protocol = 'https:';
	upstreamUrl.port = '443';

	// 将已过滤和排序的参数附加到上游 URL
	upstreamUrl.search = filteredSearchParams.toString();

	console.log('Fetching from upstream:', upstreamUrl.toString());

	const upstreamRequest = new Request(upstreamUrl.toString(), {
		method: request.method,
		headers: request.headers,
	});
	return await fetch(upstreamRequest);
}

async function storeInS3(key: string, response: Response, env: Env) {
	const buffered = await response.arrayBuffer();

	// 检查响应的 Content-Type
	const contentType = response.headers.get('Content-Type');

	if (!contentType) {
		return new Error('Content-Type is missing.');
	}

	if (!imageContentTypes.includes(contentType)) {
		return new Error('Content-Type not in the allowlist.');
	}

	await env.FCC_BUCKET.put(`cache/${key}`, buffered, {
		httpMetadata: {
			contentType: contentType,
		},
	});

	return new Response(`Put ${key} successfully!`);
}

export default {
	async fetch(request, env: Env, ctx): Promise<Response> {
		try {
			const url = new URL(request.url);
			// 获取路径
			const path = url.pathname.slice(1);
			// 获取原始查询参数
			const originalSearchParams = new URLSearchParams(url.search);
			// 创建新的查询参数对象，只包含白名单中的参数
			const filteredSearchParams = new URLSearchParams();
			const allowedParams = ['w', 'h', 'q', 'f'];

			allowedParams.forEach((param) => {
				if (originalSearchParams.has(param)) {
					filteredSearchParams.set(param, originalSearchParams.get(param)!);
				}
			});

			// 对参数进行排序以确保键的一致性
			filteredSearchParams.sort();

			// 生成过滤后的查询字符串
			const filteredSearch = filteredSearchParams.toString();
			// 组合路径和过滤后的查询参数作为缓存键
			const key = filteredSearch ? `${path}?${filteredSearch}` : path;
			console.log('Cache key:', key);

			// 检查路径是否在白名单中
			if (!WHITELISTED_PATHS.some((whitelistedPath) => url.pathname.startsWith(whitelistedPath))) {
				return new Response('Access URI is forbidden.', { status: 403 });
			}
			// 先尝试从 S3 获取
			let cachedObject = await env.FCC_BUCKET.get(`cache/${key}`);

			if (
				cachedObject &&
				cachedObject.size > 0 &&
				cachedObject.httpMetadata?.contentType &&
				imageContentTypes.includes(cachedObject.httpMetadata.contentType)
			) {
				const headers = new Headers();
				cachedObject.writeHttpMetadata(headers);
				headers.set('etag', cachedObject.httpEtag);

				return new Response(cachedObject.body, {
					headers,
				});
			}

			// 如果 S3 中没有，尝试从上游获取
			let response = await fetchFromUpstream(request, filteredSearchParams);
			// 检查上游响应是否成功
			if (response && response.ok) {
				// 存储到 S3
				// Use ctx.waitUntil to allow the request to return while the write to S3 happens in the background.
				ctx.waitUntil(storeInS3(key, response.clone(), env));
				return response; // 返回上游的响应
			} else if (response) {
				// 如果上游响应不成功，直接返回该响应
				return response;
			}

			// 如果两者都没有，返回 404
			return new Response('Access URI is not found', { status: 404 });
		} catch (error) {
			console.error('Error happen when access:', request.url, `Error:`, error);
			return new Response('Something wrong. please contact admin ASAP.', { status: 500 });
		} // Removed extra comma causing syntax error
	},
} satisfies ExportedHandler<Env>;
