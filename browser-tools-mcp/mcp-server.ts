#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "path";
import fs from "fs";

// Create the MCP server
const server = new McpServer({
  name: "Browser Tools MCP",
  version: "1.2.0",
});

// Track the discovered server connection
let discoveredHost = "127.0.0.1";
let discoveredPort = 3025;
let serverDiscovered = false;

// Function to get the default port from environment variable or default
function getDefaultServerPort(): number {
  // Check environment variable first
  if (process.env.BROWSER_TOOLS_PORT) {
    const envPort = parseInt(process.env.BROWSER_TOOLS_PORT, 10);
    if (!isNaN(envPort) && envPort > 0) {
      return envPort;
    }
  }

  // Try to read from .port file
  try {
    const portFilePath = path.join(__dirname, ".port");
    if (fs.existsSync(portFilePath)) {
      const port = parseInt(fs.readFileSync(portFilePath, "utf8").trim(), 10);
      if (!isNaN(port) && port > 0) {
        return port;
      }
    }
  } catch (err) {
    console.error("Error reading port file:", err);
  }

  // Default port if no configuration found
  return 3025;
}

// Function to get default server host from environment variable or default
function getDefaultServerHost(): string {
  // Check environment variable first
  if (process.env.BROWSER_TOOLS_HOST) {
    return process.env.BROWSER_TOOLS_HOST;
  }

  // Default to localhost
  return "127.0.0.1";
}

// Server discovery function - similar to what you have in the Chrome extension
async function discoverServer(): Promise<boolean> {
  console.log("Starting server discovery process");

  // Common hosts to try
  const hosts = [getDefaultServerHost(), "127.0.0.1", "localhost"];

  // Ports to try (start with default, then try others)
  const defaultPort = getDefaultServerPort();
  const ports = [defaultPort];

  // Add additional ports (fallback range)
  for (let p = 3025; p <= 3035; p++) {
    if (p !== defaultPort) {
      ports.push(p);
    }
  }

  console.log(`Will try hosts: ${hosts.join(", ")}`);
  console.log(`Will try ports: ${ports.join(", ")}`);

  // Try to find the server
  for (const host of hosts) {
    for (const port of ports) {
      try {
        console.log(`Checking ${host}:${port}...`);

        // Use the identity endpoint for validation
        const response = await fetch(`http://${host}:${port}/.identity`, {
          signal: AbortSignal.timeout(1000), // 1 second timeout
        });

        if (response.ok) {
          const identity = await response.json();

          // Verify this is actually our server by checking the signature
          if (identity.signature === "mcp-browser-connector-24x7") {
            console.log(`Successfully found server at ${host}:${port}`);

            // Save the discovered connection
            discoveredHost = host;
            discoveredPort = port;
            serverDiscovered = true;

            return true;
          }
        }
      } catch (error: any) {
        // Ignore connection errors during discovery
        console.error(`Error checking ${host}:${port}: ${error.message}`);
      }
    }
  }

  console.error("No server found during discovery");
  return false;
}

// Wrapper function to ensure server connection before making requests
async function withServerConnection<T>(
  apiCall: () => Promise<T>
): Promise<T | any> {
  // Attempt to discover server if not already discovered
  if (!serverDiscovered) {
    const discovered = await discoverServer();
    if (!discovered) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to discover browser connector server. Please ensure it's running.",
          },
        ],
        isError: true,
      };
    }
  }

  // Now make the actual API call with discovered host/port
  try {
    return await apiCall();
  } catch (error: any) {
    // If the request fails, try rediscovering the server once
    console.error(
      `API call failed: ${error.message}. Attempting rediscovery...`
    );
    serverDiscovered = false;

    if (await discoverServer()) {
      console.error("Rediscovery successful. Retrying API call...");
      try {
        // Retry the API call with the newly discovered connection
        return await apiCall();
      } catch (retryError: any) {
        console.error(`Retry failed: ${retryError.message}`);
        return {
          content: [
            {
              type: "text",
              text: `Error after reconnection attempt: ${retryError.message}`,
            },
          ],
          isError: true,
        };
      }
    } else {
      console.error("Rediscovery failed. Could not reconnect to server.");
      return {
        content: [
          {
            type: "text",
            text: `Failed to reconnect to server: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
}

// We'll define our tools that retrieve data from the browser connector
server.tool("getConsoleLogs", "Check our browser logs", async () => {
  return await withServerConnection(async () => {
    const response = await fetch(
      `http://${discoveredHost}:${discoveredPort}/console-logs`
    );
    const json = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json, null, 2),
        },
      ],
    };
  });
});

server.tool(
  "getConsoleErrors",
  "Check our browsers console errors",
  async () => {
    return await withServerConnection(async () => {
      const response = await fetch(
        `http://${discoveredHost}:${discoveredPort}/console-errors`
      );
      const json = await response.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(json, null, 2),
          },
        ],
      };
    });
  }
);

server.tool("getNetworkErrors", "Check our network ERROR logs", async () => {
  return await withServerConnection(async () => {
    const response = await fetch(
      `http://${discoveredHost}:${discoveredPort}/network-errors`
    );
    const json = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json, null, 2),
        },
      ],
      isError: true,
    };
  });
});

server.tool("getNetworkLogs", "Check ALL our network logs", async () => {
  return await withServerConnection(async () => {
    const response = await fetch(
      `http://${discoveredHost}:${discoveredPort}/network-success`
    );
    const json = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json, null, 2),
        },
      ],
    };
  });
});

server.tool(
  "takeScreenshot",
  "Take a screenshot of the current browser tab",
  async () => {
    return await withServerConnection(async () => {
      try {
        const response = await fetch(
          `http://${discoveredHost}:${discoveredPort}/capture-screenshot`,
          {
            method: "POST",
          }
        );

        const result = await response.json();

        if (response.ok) {
          return {
            content: [
              {
                type: "text",
                text: "Successfully saved screenshot",
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Error taking screenshot: ${result.error}`,
              },
            ],
          };
        }
      } catch (error: any) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to take screenshot: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }
);

server.tool(
  "getSelectedElement",
  "Get the selected element from the browser",
  async () => {
    return await withServerConnection(async () => {
      const response = await fetch(
        `http://${discoveredHost}:${discoveredPort}/selected-element`
      );
      const json = await response.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(json, null, 2),
          },
        ],
      };
    });
  }
);

server.tool("wipeLogs", "Wipe all browser logs from memory", async () => {
  return await withServerConnection(async () => {
    const response = await fetch(
      `http://${discoveredHost}:${discoveredPort}/wipelogs`,
      {
        method: "POST",
      }
    );
    const json = await response.json();
    return {
      content: [
        {
          type: "text",
          text: json.message,
        },
      ],
    };
  });
});

// Define audit categories as enum to match the server's AuditCategory enum
enum AuditCategory {
  ACCESSIBILITY = "accessibility",
  PERFORMANCE = "performance",
  SEO = "seo",
  BEST_PRACTICES = "best-practices",
  PWA = "pwa",
}

// Add tool for accessibility audits, launches a headless browser instance
server.tool(
  "runAccessibilityAudit",
  "Run an accessibility audit on the current page",
  {},
  async () => {
    return await withServerConnection(async () => {
      try {
        // Simplified approach - let the browser connector handle the current tab and URL
        console.log(
          `Sending POST request to http://${discoveredHost}:${discoveredPort}/accessibility-audit`
        );
        const response = await fetch(
          `http://${discoveredHost}:${discoveredPort}/accessibility-audit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              category: AuditCategory.ACCESSIBILITY,
              source: "mcp_tool",
              timestamp: Date.now(),
            }),
          }
        );

        // Log the response status
        console.log(`Accessibility audit response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Accessibility audit error: ${errorText}`);
          throw new Error(`Server returned ${response.status}: ${errorText}`);
        }

        const json = await response.json();

        // flatten it by merging metadata with the report contents
        if (json.report) {
          const { metadata, report } = json;
          const flattened = {
            ...metadata,
            ...report,
          };

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(flattened, null, 2),
              },
            ],
          };
        } else {
          // Return as-is if it's not in the new format
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(json, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error("Error in accessibility audit:", errorMessage);
        return {
          content: [
            {
              type: "text",
              text: `Failed to run accessibility audit: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }
);

// Add tool for performance audits, launches a headless browser instance
server.tool(
  "runPerformanceAudit",
  "Run a performance audit on the current page",
  {},
  async () => {
    return await withServerConnection(async () => {
      try {
        // Simplified approach - let the browser connector handle the current tab and URL
        console.log(
          `Sending POST request to http://${discoveredHost}:${discoveredPort}/performance-audit`
        );
        const response = await fetch(
          `http://${discoveredHost}:${discoveredPort}/performance-audit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              category: AuditCategory.PERFORMANCE,
              source: "mcp_tool",
              timestamp: Date.now(),
            }),
          }
        );

        // Log the response status
        console.log(`Performance audit response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Performance audit error: ${errorText}`);
          throw new Error(`Server returned ${response.status}: ${errorText}`);
        }

        const json = await response.json();

        // flatten it by merging metadata with the report contents
        if (json.report) {
          const { metadata, report } = json;
          const flattened = {
            ...metadata,
            ...report,
          };

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(flattened, null, 2),
              },
            ],
          };
        } else {
          // Return as-is if it's not in the new format
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(json, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error("Error in performance audit:", errorMessage);
        return {
          content: [
            {
              type: "text",
              text: `Failed to run performance audit: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }
);

// Add tool for SEO audits, launches a headless browser instance
server.tool(
  "runSEOAudit",
  "Run an SEO audit on the current page",
  {},
  async () => {
    return await withServerConnection(async () => {
      try {
        console.log(
          `Sending POST request to http://${discoveredHost}:${discoveredPort}/seo-audit`
        );
        const response = await fetch(
          `http://${discoveredHost}:${discoveredPort}/seo-audit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              category: AuditCategory.SEO,
              source: "mcp_tool",
              timestamp: Date.now(),
            }),
          }
        );

        // Log the response status
        console.log(`SEO audit response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`SEO audit error: ${errorText}`);
          throw new Error(`Server returned ${response.status}: ${errorText}`);
        }

        const json = await response.json();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(json, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error("Error in SEO audit:", errorMessage);
        return {
          content: [
            {
              type: "text",
              text: `Failed to run SEO audit: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }
);

server.tool("runNextJSAudit", {}, async () => ({
  content: [
    {
      type: "text",
      text: `
      You are an expert in SEO and web development with NextJS. Given the following procedures for analyzing my codebase, please perform a comprehensive - page by page analysis of our NextJS application to identify any issues or areas of improvement for SEO.

      After each iteration of changes, reinvoke this tool to re-fetch our SEO audit procedures and then scan our codebase again to identify additional areas of improvement. 

      When no more areas of improvement are found, return "No more areas of improvement found, your NextJS application is optimized for SEO!".

      Start by analyzing each of the following aspects of our codebase:
      1. Meta tags - provides information about your website to search engines and social media platforms.

        Pages should provide the following standard meta tags:

        title
        description
        keywords
        robots
        viewport
        charSet
        Open Graph meta tags:

        og:site_name
        og:locale
        og:title
        og:description
        og:type
        og:url
        og:image
        og:image:alt
        og:image:type
        og:image:width
        og:image:height
        Article meta tags (actually it's also OpenGraph):

        article:published_time
        article:modified_time
        article:author
        Twitter meta tags:

        twitter:card
        twitter:site
        twitter:creator
        twitter:title
        twitter:description
        twitter:image

        For applications using the pages router, set up metatags like this in pages/[slug].tsx:
          import Head from "next/head";

          export default function Page() {
            return (
              <Head>
                <title>
                  Next.js SEO: The Complete Checklist to Boost Your Site Ranking
                </title>
                <meta
                  name="description"
                  content="Learn how to optimize your Next.js website for SEO by following this complete checklist."
                />
                <meta
                  name="keywords"
                  content="nextjs seo complete checklist, nextjs seo tutorial"
                />
                <meta name="robots" content="index, follow" />
                <meta name="googlebot" content="index, follow" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <meta charSet="utf-8" />
                <meta property="og:site_name" content="Blog | Minh Vu" />
                <meta property="og:locale" content="en_US" />
                <meta
                  property="og:title"
                  content="Next.js SEO: The Complete Checklist to Boost Your Site Ranking"
                />
                <meta
                  property="og:description"
                  content="Learn how to optimize your Next.js website for SEO by following this complete checklist."
                />
                <meta property="og:type" content="website" />
                <meta property="og:url" content="https://dminhvu.com/nextjs-seo" />
                <meta
                  property="og:image"
                  content="https://ik.imagekit.io/dminhvu/assets/nextjs-seo/thumbnail.png?tr=f-png"
                />
                <meta property="og:image:alt" content="Next.js SEO" />
                <meta property="og:image:type" content="image/png" />
                <meta property="og:image:width" content="1200" />
                <meta property="og:image:height" content="630" />
                <meta
                  property="article:published_time"
                  content="2024-01-11T11:35:00+07:00"
                />
                <meta
                  property="article:modified_time"
                  content="2024-01-11T11:35:00+07:00"
                />
                <meta
                  property="article:author"
                  content="https://www.linkedin.com/in/dminhvu02"
                />
                <meta name="twitter:card" content="summary_large_image" />
                <meta name="twitter:site" content="@dminhvu02" />
                <meta name="twitter:creator" content="@dminhvu02" />
                <meta
                  name="twitter:title"
                  content="Next.js SEO: The Complete Checklist to Boost Your Site Ranking"
                />
                <meta
                  name="twitter:description"
                  content="Learn how to optimize your Next.js website for SEO by following this complete checklist."
                />
                <meta
                  name="twitter:image"
                  content="https://ik.imagekit.io/dminhvu/assets/nextjs-seo/thumbnail.png?tr=f-png"
                />
              </Head>
            );
          }

        For applications using the app router, set up metatags like this in layout.tsx:
          import type { Viewport, Metadata } from "next";

          export const viewport: Viewport = {
            width: "device-width",
            initialScale: 1,
            themeColor: "#ffffff"
          };
          
          export const metadata: Metadata = {
            metadataBase: new URL("https://dminhvu.com"),
            openGraph: {
              siteName: "Blog | Minh Vu",
              type: "website",
              locale: "en_US"
            },
            robots: {
              index: true,
              follow: true,
              "max-image-preview": "large",
              "max-snippet": -1,
              "max-video-preview": -1,
              googleBot: "index, follow"
            },
            alternates: {
              types: {
                "application/rss+xml": "https://dminhvu.com/rss.xml"
              }
            },
            applicationName: "Blog | Minh Vu",
            appleWebApp: {
              title: "Blog | Minh Vu",
              statusBarStyle: "default",
              capable: true
            },
            verification: {
              google: "YOUR_DATA",
              yandex: ["YOUR_DATA"],
              other: {
                "msvalidate.01": ["YOUR_DATA"],
                "facebook-domain-verification": ["YOUR_DATA"]
              }
            },
            icons: {
              icon: [
                {
                  url: "/favicon.ico",
                  type: "image/x-icon"
                },
                {
                  url: "/favicon-16x16.png",
                  sizes: "16x16",
                  type: "image/png"
                }
                // add favicon-32x32.png, favicon-96x96.png, android-chrome-192x192.png
              ],
              shortcut: [
                {
                  url: "/favicon.ico",
                  type: "image/x-icon"
                }
              ],
              apple: [
                {
                  url: "/apple-icon-57x57.png",
                  sizes: "57x57",
                  type: "image/png"
                },
                {
                  url: "/apple-icon-60x60.png",
                  sizes: "60x60",
                  type: "image/png"
                }
                // add apple-icon-72x72.png, apple-icon-76x76.png, apple-icon-114x114.png, apple-icon-120x120.png, apple-icon-144x144.png, apple-icon-152x152.png, apple-icon-180x180.png
              ]
            }
          };
        And like this for any page.tsx file:
          import { Metadata } from "next";

          export const metadata: Metadata = {
            title: "Elastic Stack, Next.js, Python, JavaScript Tutorials | dminhvu",
            description:
              "dminhvu.com - Programming blog for everyone to learn Elastic Stack, Next.js, Python, JavaScript, React, Machine Learning, Data Science, and more.",
            keywords: [
              "elastic",
              "python",
              "javascript",
              "react",
              "machine learning",
              "data science"
            ],
            openGraph: {
              url: "https://dminhvu.com",
              type: "website",
              title: "Elastic Stack, Next.js, Python, JavaScript Tutorials | dminhvu",
              description:
                "dminhvu.com - Programming blog for everyone to learn Elastic Stack, Next.js, Python, JavaScript, React, Machine Learning, Data Science, and more.",
              images: [
                {
                  url: "https://dminhvu.com/images/home/thumbnail.png",
                  width: 1200,
                  height: 630,
                  alt: "dminhvu"
                }
              ]
            },
            twitter: {
              card: "summary_large_image",
              title: "Elastic Stack, Next.js, Python, JavaScript Tutorials | dminhvu",
              description:
                "dminhvu.com - Programming blog for everyone to learn Elastic Stack, Next.js, Python, JavaScript, React, Machine Learning, Data Science, and more.",
              creator: "@dminhvu02",
              site: "@dminhvu02",
              images: [
                {
                  url: "https://dminhvu.com/images/home/thumbnail.png",
                  width: 1200,
                  height: 630,
                  alt: "dminhvu"
                }
              ]
            },
            alternates: {
              canonical: "https://dminhvu.com"
            }
          };

          Note that the charSet and viewport are automatically added by Next.js App Router, so you don't need to define them.

        For applications using the app router, dynamic metadata can be defined by using the generateMetadata function, this is useful when you have dynamic pages like [slug]/page.tsx, or [id]/page.tsx:

        import type { Metadata, ResolvingMetadata } from "next";

        type Params = {
          slug: string;
        };
        
        type Props = {
          params: Params;
          searchParams: { [key: string]: string | string[] | undefined };
        };
        
        export async function generateMetadata(
          { params, searchParams }: Props,
          parent: ResolvingMetadata
        ): Promise<Metadata> {
          const { slug } = params;
        
          const post: Post = await fetch("YOUR_ENDPOINT", {
            method: "GET",
            next: {
              revalidate: 60 * 60 * 24
            }
          }).then((res) => res.json());
        
          return {
            title: "{post.title} | dminhvu",
            authors: [
              {
                name: post.author || "Minh Vu"
              }
            ],
            description: post.description,
            keywords: post.keywords,
            openGraph: {
              title: "{post.title} | dminhvu",
              description: post.description,
              type: "article",
              url: "https://dminhvu.com/{post.slug}",
              publishedTime: post.created_at,
              modifiedTime: post.modified_at,
              authors: ["https://dminhvu.com/about"],
              tags: post.categories,
              images: [
                {
                  url: "https://ik.imagekit.io/dminhvu/assets/{post.slug}/thumbnail.png?tr=f-png",
                  width: 1024,
                  height: 576,
                  alt: post.title,
                  type: "image/png"
                }
              ]
            },
            twitter: {
              card: "summary_large_image",
              site: "@dminhvu02",
              creator: "@dminhvu02",
              title: "{post.title} | dminhvu",
              description: post.description,
              images: [
                {
                  url: "https://ik.imagekit.io/dminhvu/assets/{post.slug}/thumbnail.png?tr=f-png",
                  width: 1024,
                  height: 576,
                  alt: post.title
                }
              ]
            },
            alternates: {
              canonical: "https://dminhvu.com/{post.slug}"
            }
          };
        }

        
      2. JSON-LD Schema

      JSON-LD is a format for structured data that can be used by search engines to understand your content. For example, you can use it to describe a person, an event, an organization, a movie, a book, a recipe, and many other types of entities.

      Our current recommendation for JSON-LD is to render structured data as a <script> tag in your layout.js or page.js components. For example:
      export default async function Page({ params }) {
        const { id } = await params
        const product = await getProduct(id)
      
        const jsonLd = {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: product.name,
          image: product.image,
          description: product.description,
        }
      
        return (
          <section>
            {/* Add JSON-LD to your page */}
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
            />
            {/* ... */}
          </section>
        )
      }
      
      You can type your JSON-LD with TypeScript using community packages like schema-dts:


      import { Product, WithContext } from 'schema-dts'
      
      const jsonLd: WithContext<Product> = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Next.js Sticker',
        image: 'https://nextjs.org/imgs/sticker.png',
        description: 'Dynamic at the speed of static.',
      }
      3. Sitemap
      Your website should provide a sitemap so that search engines can easily crawl and index your pages.

        Generate Sitemap for Next.js Pages Router
        For Next.js Pages Router, you can use next-sitemap to generate a sitemap for your Next.js website after building.

        For example, running the following command will install next-sitemap and generate a sitemap for this blog:


        npm install next-sitemap
        npx next-sitemap
        A sitemap will be generated at public/sitemap.xml:

        public/sitemap.xml

        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:mobile="http://www.google.com/schemas/sitemap-mobile/1.0" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
        <url>
          <loc>https://dminhvu.com</loc>
            <lastmod>2024-01-11T02:03:09.613Z</lastmod>
            <changefreq>daily</changefreq>
          <priority>0.7</priority>
        </url>
        <!-- other pages -->
        </urlset>
        Please visit the next-sitemap page for more information.

        Generate Sitemap for Next.js App Router
        For Next.js App Router, you can define the sitemap.ts file at app/sitemap.ts:

        app/sitemap.ts

        import {
          getAllCategories,
          getAllPostSlugsWithModifyTime
        } from "@/utils/getData";
        import { MetadataRoute } from "next";
        
        export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
          const defaultPages = [
            {
              url: "https://dminhvu.com",
              lastModified: new Date(),
              changeFrequency: "daily",
              priority: 1
            },
            {
              url: "https://dminhvu.com/about",
              lastModified: new Date(),
              changeFrequency: "monthly",
              priority: 0.9
            },
            {
              url: "https://dminhvu.com/contact",
              lastModified: new Date(),
              changeFrequency: "monthly",
              priority: 0.9
            }
            // other pages
          ];
        
          const postSlugs = await getAllPostSlugsWithModifyTime();
          const categorySlugs = await getAllCategories();
        
          const sitemap = [
            ...defaultPages,
            ...postSlugs.map((e: any) => ({
              url: "https://dminhvu.com/{e.slug}",
              lastModified: e.modified_at,
              changeFrequency: "daily",
              priority: 0.8
            })),
            ...categorySlugs.map((e: any) => ({
              url: "https://dminhvu.com/category/{e}",
              lastModified: new Date(),
              changeFrequency: "daily",
              priority: 0.7
            }))
          ];
        
          return sitemap;
        }
        With this sitemap.ts file created, you can access the sitemap at https://dminhvu.com/sitemap.xml.


        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url>
            <loc>https://dminhvu.com</loc>
            <lastmod>2024-01-11T02:03:09.613Z</lastmod>
            <changefreq>daily</changefreq>
            <priority>0.7</priority>
          </url>
          <!-- other pages -->
        </urlset>
      4. robots.txt
      A robots.txt file should be added to tell search engines which pages to crawl and which pages to ignore.

        robots.txt for Next.js Pages Router
        For Next.js Pages Router, you can create a robots.txt file at public/robots.txt:

        public/robots.txt

        User-agent: *
        Disallow:
        Sitemap: https://dminhvu.com/sitemap.xml
        You can prevent the search engine from crawling a page (usually search result pages, noindex pages, etc.) by adding the following line:

        public/robots.txt

        User-agent: *
        Disallow: /search?q=
        Disallow: /admin
        robots.txt for Next.js App Router
        For Next.js App Router, you don't need to manually define a robots.txt file. Instead, you can define the robots.ts file at app/robots.ts:

        app/robots.ts

        import { MetadataRoute } from "next";
        
        export default function robots(): MetadataRoute.Robots {
          return {
            rules: {
              userAgent: "*",
              allow: ["/"],
              disallow: ["/search?q=", "/admin/"]
            },
            sitemap: ["https://dminhvu.com/sitemap.xml"]
          };
        }
        With this robots.ts file created, you can access the robots.txt file at https://dminhvu.com/robots.txt.


        User-agent: *
        Allow: /
        Disallow: /search?q=
        Disallow: /admin
        
        Sitemap: https://dminhvu.com/sitemap.xml
      5. Link tags
      Link Tags for Next.js Pages Router
      For example, the current page has the following link tags if I use the Pages Router:

      pages/_app.tsx

      import Head from "next/head";
      
      export default function Page() {
        return (
          <Head>
            {/* other parts */}
            <link
              rel="alternate"
              type="application/rss+xml"
              href="https://dminhvu.com/rss.xml"
            />
            <link rel="icon" href="/favicon.ico" type="image/x-icon" />
            <link rel="apple-touch-icon" sizes="57x57" href="/apple-icon-57x57.png" />
            <link rel="apple-touch-icon" sizes="60x60" href="/apple-icon-60x60.png" />
            {/* add apple-touch-icon-72x72.png, apple-touch-icon-76x76.png, apple-touch-icon-114x114.png, apple-touch-icon-120x120.png, apple-touch-icon-144x144.png, apple-touch-icon-152x152.png, apple-touch-icon-180x180.png */}
            <link
              rel="icon"
              type="image/png"
              href="/favicon-16x16.png"
              sizes="16x16"
            />
            {/* add favicon-32x32.png, favicon-96x96.png, android-chrome-192x192.png */}
          </Head>
        );
      }
      pages/[slug].tsx

      import Head from "next/head";
      
      export default function Page() {
        return (
          <Head>
            {/* other parts */}
            <link rel="canonical" href="https://dminhvu.com/nextjs-seo" />
          </Head>
        );
      }
      Link Tags for Next.js App Router
      For Next.js App Router, the link tags can be defined using the export const metadata or generateMetadata similar to the meta tags section.

      The code below is exactly the same as the meta tags for Next.js App Router section above.

      app/layout.tsx

      export const metadata: Metadata = {
        // other parts
        alternates: {
          types: {
            "application/rss+xml": "https://dminhvu.com/rss.xml"
          }
        },
        icons: {
          icon: [
            {
              url: "/favicon.ico",
              type: "image/x-icon"
            },
            {
              url: "/favicon-16x16.png",
              sizes: "16x16",
              type: "image/png"
            }
            // add favicon-32x32.png, favicon-96x96.png, android-chrome-192x192.png
          ],
          shortcut: [
            {
              url: "/favicon.ico",
              type: "image/x-icon"
            }
          ],
          apple: [
            {
              url: "/apple-icon-57x57.png",
              sizes: "57x57",
              type: "image/png"
            },
            {
              url: "/apple-icon-60x60.png",
              sizes: "60x60",
              type: "image/png"
            }
            // add apple-icon-72x72.png, apple-icon-76x76.png, apple-icon-114x114.png, apple-icon-120x120.png, apple-icon-144x144.png, apple-icon-152x152.png, apple-icon-180x180.png
          ]
        }
      };
      app/page.tsx

      export const metadata: Metadata = {
        // other parts
        alternates: {
          canonical: "https://dminhvu.com"
        }
      };
      6. Script optimization
      Script Optimization for General Scripts
      Next.js provides a built-in component called <Script> to add external scripts to your website.

      For example, you can add Google Analytics to your website by adding the following script tag:

      pages/_app.tsx

      import Head from "next/head";
      import Script from "next/script";
      
      export default function Page() {
        return (
          <Head>
            {/* other parts */}
            {process.env.NODE_ENV === "production" && (
              <>
                <Script async strategy="afterInteractive" id="analytics">
                  {'
                    window.dataLayer = window.dataLayer || [];
                    function gtag(){dataLayer.push(arguments);}
                    gtag('js', new Date());
                    gtag('config', 'G-XXXXXXXXXX');
                  '}
                </Script>
              </>
            )}
          </Head>
        );
      }
      Script Optimization for Common Third-Party Integrations
      Next.js App Router introduces a new library called @next/third-parties for:

      Google Tag Manager
      Google Analytics
      Google Maps Embed
      YouTube Embed
      To use the @next/third-parties library, you need to install it:


      npm install @next/third-parties
      Then, you can add the following code to your app/layout.tsx:

      app/layout.tsx

      import { GoogleTagManager } from "@next/third-parties/google";
      import { GoogleAnalytics } from "@next/third-parties/google";
      import Head from "next/head";
      
      export default function Page() {
        return (
          <html lang="en" className="scroll-smooth" suppressHydrationWarning>
            {process.env.NODE_ENV === "production" && (
              <>
                <GoogleAnalytics gaId="G-XXXXXXXXXX" />
                {/* other scripts */}
              </>
            )}
            {/* other parts */}
          </html>
        );
      }
      Please note that you don't need to include both GoogleTagManager and GoogleAnalytics if you only use one of them.
      7. Image optimization
      Image Optimization
      This part can be applied to both Pages Router and App Router.

      Image optimization is also an important part of SEO as it helps your website load faster.

      Faster image rendering speed will contribute to the Google PageSpeed score, which can improve user experience and SEO.

      You can use next/image to optimize images in your Next.js website.

      For example, the following code will optimize this post thumbnail:


      import Image from "next/image";
      
      export default function Page() {
        return (
          <Image
            src="https://ik.imagekit.io/dminhvu/assets/nextjs-seo/thumbnail.png?tr=f-webp"
            alt="Next.js SEO"
            width={1200}
            height={630}
          />
        );
      }
      Remember to use a CDN to serve your media (images, videos, etc.) to improve the loading speed.

      For the image format, use WebP if possible because it has a smaller size than PNG and JPEG.

      Given the provided procedures, begin by analyzing all of our Next.js pages.
      Check to see what metadata already exists, look for any robot.txt files, and take a closer look at some of the other aspects of our project to determine areas of improvement.
      Once you've performed this comprehensive analysis, return back a report on what we can do to improve our application.
      Do not actually make the code changes yet, just return a comprehensive plan that you will ask for approval for.
      If feedback is provided, adjust the plan accordingly and ask for approval again.
      If the user approves of the plan, go ahead and proceed to implement all the necessary code changes to completely optimize our application.
    `,
    },
  ],
}));

server.tool(
  "runDebuggerMode",
  "Run debugger mode to debug an issue in our application",
  async () => ({
    content: [
      {
        type: "text",
        text: `
      Please follow this exact sequence to debug an issue in our application:
  
  1. Reflect on 5-7 different possible sources of the problem
  2. Distill those down to 1-2 most likely sources
  3. Add additional logs to validate your assumptions and track the transformation of data structures throughout the application control flow before we move onto implementing the actual code fix
  4. Use the "getConsoleLogs", "getConsoleErrors", "getNetworkLogs" & "getNetworkErrors" tools to obtain any newly added web browser logs
  5. Obtain the server logs as well if accessible - otherwise, ask me to copy/paste them into the chat
  6. Deeply reflect on what could be wrong + produce a comprehensive analysis of the issue
  7. Suggest additional logs if the issue persists or if the source is not yet clear
  8. Once a fix is implemented, ask for approval to remove the previously added logs

  Note: DO NOT run any of our audits (runAccessibilityAudit, runPerformanceAudit, runBestPracticesAudit, runSEOAudit, runNextJSAudit) when in debugging mode unless explicitly asked to do so or unless you switch to audit mode.
`,
      },
    ],
  })
);

server.tool(
  "runAuditMode",
  "Run audit mode to optimize our application for SEO, accessibility and performance",
  async () => ({
    content: [
      {
        type: "text",
        text: `
      I want you to enter "Audit Mode". Use the following MCP tools one after the other in this exact sequence:
      
      1. runAccessibilityAudit
      2. runPerformanceAudit
      3. runBestPracticesAudit
      4. runSEOAudit
      5. runNextJSAudit (only if our application is ACTUALLY using NextJS)

      After running all of these tools, return back a comprehensive analysis of the audit results.

      Do NOT use runNextJSAudit tool unless you see that our application is ACTUALLY using NextJS.

      DO NOT use the takeScreenshot tool EVER during audit mode. ONLY use it if I specifically ask you to take a screenshot of something.

      DO NOT check console or network logs to get started - your main priority is to run the audits in the sequence defined above.
      
      After returning an in-depth analysis, scan through my code and identify various files/parts of my codebase that we want to modify/improve based on the results of our audits.

      After identifying what changes may be needed, do NOT make the actual changes. Instead, return back a comprehensive, step-by-step plan to address all of these changes and ask for approval to execute this plan. If feedback is received, make a new plan and ask for approval again. If approved, execute the ENTIRE plan and after all phases/steps are complete, re-run the auditing tools in the same 4 step sequence again before returning back another analysis for additional changes potentially needed.

      Keep repeating / iterating through this process with the four tools until our application is as optimized as possible for SEO, accessibility and performance.

`,
      },
    ],
  })
);

// Add tool for Best Practices audits, launches a headless browser instance
server.tool(
  "runBestPracticesAudit",
  "Run a best practices audit on the current page",
  {},
  async () => {
    return await withServerConnection(async () => {
      try {
        console.log(
          `Sending POST request to http://${discoveredHost}:${discoveredPort}/best-practices-audit`
        );
        const response = await fetch(
          `http://${discoveredHost}:${discoveredPort}/best-practices-audit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              source: "mcp_tool",
              timestamp: Date.now(),
            }),
          }
        );

        // Check for errors
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Server returned ${response.status}: ${errorText}`);
        }

        const json = await response.json();

        // flatten it by merging metadata with the report contents
        if (json.report) {
          const { metadata, report } = json;
          const flattened = {
            ...metadata,
            ...report,
          };

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(flattened, null, 2),
              },
            ],
          };
        } else {
          // Return as-is if it's not in the new format
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(json, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error("Error in Best Practices audit:", errorMessage);
        return {
          content: [
            {
              type: "text",
              text: `Failed to run Best Practices audit: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }
);

// Start receiving messages on stdio
(async () => {
  try {
    // Attempt initial server discovery
    console.error("Attempting initial server discovery on startup...");
    await discoverServer();
    if (serverDiscovered) {
      console.error(
        `Successfully discovered server at ${discoveredHost}:${discoveredPort}`
      );
    } else {
      console.error(
        "Initial server discovery failed. Will try again when tools are used."
      );
    }

    const transport = new StdioServerTransport();

    // Ensure stdout is only used for JSON messages
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
      // Only allow JSON messages to pass through
      if (typeof chunk === "string" && !chunk.startsWith("{")) {
        return true; // Silently skip non-JSON messages
      }
      return originalStdoutWrite(chunk, encoding, callback);
    };

    await server.connect(transport);
  } catch (error) {
    console.error("Failed to initialize MCP server:", error);
    process.exit(1);
  }
})();
