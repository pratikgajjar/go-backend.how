+++
title = "Achieve 60ms Response Time Using ValKey"
description = ""
date = 2024-06-16T23:27:27+05:30
lastmod = 2024-06-16T23:27:27+05:30
draft = true
images = []
+++

You will be able to use valkey like swiss-knife it is to serve web pages at blazingly fast speed. 

# Why ? 
- Co-founder set the 60ms benchmark value that engineering team needs solve for.
- 95%+ traffic comes from Google, Facebook, Instagram Ads. On click - 2 methods car can be displayed to the user
  1. Dedicated Page - full details of 1 car, with 10+ photos and other information 
  2. Listing Page - List of cars - basic details and ~4 photos horizontally scrollable

> Amazon found that every 100ms of latency cost them 1% in sales. In 2006, Google found an extra .5 seconds in search page generation time dropped traffic by 20%. - [Marissa Mayer](http://glinden.blogspot.com/2006/11/marissa-mayer-at-web-20.html)

# Spec

- Maximum 10,000 cars can be active available for users to view
- Listing Page 
  - Shows list of cars based on order returned by [LightFM](https://github.com/lyst/lightfm) model
  - User can filter based on car attributes 
- User can be anonymous user or returning user who has filled the lead earlier.
  - For anonymous user use current_car or last_visited car stored in local storage.
  - Logged In user will get recommendation based on all the interaction they have done on platform.

# Exisitng design

- React PWA (Progressive Web App) App built using create-react-app as frontend.
- REST API implemented via Django with Django-Rest-Framework.

# Bottlenecks

## Frontend
PWA - Fastest way to render the page is to send rendered HTML and PWA doesn't do that, it works well after first page load, navigation and offline experiance but not for the first render.

Why have PWA? 
- In lifecycle of user once they decided to buy the car or bought the car, they would not need the platform so encourging someone to install the app felt extra step that user can skip.

## Backend

Request - Response lifecycle

User → Load JS/CSS bundle (PWA)

→ HTTPS REST API Request

→ AWS Load Balancer (HTTPS termination)

→ Apache 2 Server WSGI extension - prefork (Ec2 Instance)

→ Django WSGI Handler - Python Process

→ Middleware → Create DB connection (1 for each request)

→ Django-Rest-Framework View

→ Model Serializers (n + 1 DB call) ~200 | **90% time spent here onwards** |

→ Automatic Caching via CacheALot 

→ DB Response

→ Convert JSON → Return to Apache2 → Load Balancer → User 


Didn't make sense what just happened ? it's okay. Not important to understand rest of the story. (Google unfamiliar terms or comment !)

Here for Listing API - we need to calculate order of cars from model response and based on that paginate. Paginate - Backend returns 10 cars max in each response, for more in subsquent API request marker is sent to backend to skip to seen results. 

# Solution 

## Frontend

We decided to opt for Next.js and send rendered html for the first page open. Once user is on either dedicated or listing page and interacts with site to go back or visit other cars it would fallback to rendering everything on client side, this allows smooth experiance like native apps.

## Backend

1. Make minimum amount of network calls.
2. Serve page via only valkey (cache), 100% hit ratio.

To keep in mind; 
- Every day car prices changes automatically.
- Operation team can make new car live anytime
- To render full car data - it uses ~10 tables from normalised schema
- All changes to db can be done through different portals.
  - Operation portal built using cakephp app - perform operations
  - Inventory App - that talks to different django application
  - Data Science python scripts to update prices in bulk.


### Cache Invalidation 

In MySQL, you can listen to binlog and get notified about all changes to the table - DDL & DML
(Not Dilwale Dulhaniya Le jaenge)
 
- Data defiantion language 
  - CREATE | ALTER | DROP TABLE
- Data modification language
  - INSERT | UPDATE | DELETE | REPLACE FROM TABLE 

Using python library to hook into mysql change log, we emitted changes to kafka topic.

Topic - Log file where you can only append.

```
Topic Name:

  {database_name}.{table_name}

Messages:

   op: insert | delete | update

   before: json payload with key = column name, value = column value

   after: json payload

```

