+++
title = "Achieve 60ms Response Time Using ValKey: Part 1"
description = "You will be able to use valkey like swiss-knife it is to serve web pages at blazingly fast speed."
date = 2024-06-16T23:27:27+05:30
lastmod = 2024-06-16T23:27:27+05:30
draft = false
images = []
+++

[Latest published blog](/posts/creating-content/) 

Hey! This is work in progress, if you want to still go ahead feel free. Didn't want to keep draft with me. TY

You'll be able to use [Valkey](https://valkey.io/) as a versatile tool to serve web pages at blazingly fast speeds.

Before diving in, this blog assumes you're familiar with backend technology.

{{< details "What is Valkey?" >}}
Valkey is an open-source (BSD) high-performance key/value datastore. It supports various workloads such as caching, message queues, and can function as a primary database. Valkey can operate as a standalone daemon or in a cluster, with options for replication and high availability.

Does this sound familiar? The folks at Redis changed their license terms, leading to the creation of this fork, more at [link](https://arstechnica.com/information-technology/2024/04/redis-license-change-and-forking-are-a-mess-that-everybody-can-feel-bad-about/). 
{{</details>}}
It's fork of redis open-source, as they changed license terms.

# What ?
Here we have pre owned car platform where buyers can find detailed report of car, schedule a test drive and purchase.
The platform has hybrid business model - marketplace & inventory. 

Marketplace - We are providing platform for buyers and sellers to communicate. When you purchase something which is directly sold by seller. Earn money from both ends, buyer => seller contact details, seller => Who has shown interest.

Inventory - Platform owns the car, buyer can book test drive online and each location has ~100+ cars, buyer can go there and test drive. Earn money from higher margin on car. Pro-tip - before selling house -> repaint, car -> refurbish.

Flow of user

Ads => Lead generation (Entered mobile no) => Platform (Book visit) => Test Drive (At store) => Make purchase decision.

Our goal is to maximise Lead generation via providing blazingly fast experience.

# Why ? 
- The co-founder set a target of 60ms for most impactful entrypoints.
- 95%+ traffic comes from Google, Facebook, Instagram Ads. The Ads would lead to two entrypoints of the app.
  1. Dedicated Page - Full details of one car, including 10+ photos and other information.
  2. Listing Page - A list of cars with basic details and approximately four horizontally scrollable photos.

> Amazon found that every 100ms of latency cost them 1% in sales. In 2006, Google found an extra .5 seconds in search page generation time dropped traffic by 20%. - [Marissa Mayer](http://glinden.blogspot.com/2006/11/marissa-mayer-at-web-20.html)

# Specifications

- Up to 10,000 cars can be active and available for users to view.
- Listing Page 
  - Displays cars based on the order returned by the [LightFM](https://github.com/lyst/lightfm) model
  - User can filter based on car attributes 
- Users can be anonymous or returning users who have filled out a lead earlier.
  - For anonymous users, use the current car or last-visited car stored in local storage.
  - Logged-in users will receive recommendations based on their interactions on the platform.

# Exisitng design

- React Progressive Web App (PWA) built using [create-react-app](https://create-react-app.dev/) as the frontend.
- REST API implemented via [Django](https://www.djangoproject.com/) with Django-Rest-Framework.

# Bottlenecks

## Frontend

PWAs render pages quickly after the first load but struggle with the initial render. Despite this, they provide a smooth experience after the first load, navigation, and offline access.

## Backend

Request - Response lifecycle

1. User clicks
2. Load JS/CSS bundle (PWA)
3. HTTPS REST API Request
4. AWS Load Balancer (HTTPS termination)
5. Apache 2 Server WSGI extension - prefork (Ec2 Instance)
6. Django WSGI Handler - Python Process
7. Middleware → Create DB connection (1 for each request)
8. Django-Rest-Framework View
9. Model Serializers (n + 1 DB call) ~200 | **90% time spent here onwards** |
10. Automatic Caching via ORM hooks by Cache-A-Lot library
  - Creates hash of query and stores db response in pickle format
  - Handles invalidation using django model signals
11. DB Response
12. Convert JSON → Return to Apache2 → Load Balancer → User 


Didn't understand? That's okay. It's not crucial for the rest of the story. You can Google unfamiliar terms or ask for clarification!

#### Dedicated Page
Backend receives an `id`, fetch the data and return json

#### Listing Page
Accept - `buyer_id`, `seen_car_ids`

Data Science model can use either of above parameters and create recommendation for the user. 
```python
def personal_reco(buyer_id, active_car_id_list):
    ordered_car_list = model.get_order(buyer_id, active_car_id_list)
    return ordered_car_list

def anon_reco(seen_car_ids, active_car_id_list):
    ordered_car_list = model.get_order(seen_car_ids, active_car_id_list)
    return ordered_car_list
```
Should we return data of all active cars in the first request?

No, that would cause unnecessary computation on the backend since it is unlikely that the user would scroll through all the cars.

Instead, we return the first 10 results and a marker for the next page to the frontend. In subsequent requests, the frontend sends the marker to the backend, which then returns the next set of results, skipping the already seen cars.

Here at run time we compute order of car on each request.

#### Filters

What are we filtering exactly ? - Car colour, Make, Model, Accessory, Rating, Ownership etc.

In normalised database there are several kind of data relations a car can have with other tables

1. One to One
  - Car has blue color => `car.color_id - color.id`
  - Car variant is e-tron => `car.variant_id - variant.id`
  - Car model is Q7 => `variant.model_id - model.id`
  - Car manufactured by Audi => `make.model_id = model.id`
2. One to Many
  - One Car has Many acessories.
   [TODO]
3. Many to Many
   [TODO]

Here we used django-filter to traverse the relations and perform `in` , `not in` queries.

Since we were making complex queries during filter with 5+ joins, these queries cause high load on the database.


# Approach 

## Frontend

How does client side rendering works ? 

Once frontend receives the json payload, it creates using javascript it creates an HTML that can be used to display the data, here behind the scene react checks does it really needs to update the DOM Tree ? What part changed and it updates only changed part.

Since react here is creating html, on low end device it could be slow and once HTML generated it will perform diff then start painting the canvas. 

So why not, send HTML directly which browsers are familiar with ?

That's where Next.js (2019) comes into picture. We can run node server in backend and for the first page load always send HTML. Once the user is on either the dedicated or listing page and interacts with the site to go back or visit other cars, it will fall back to rendering everything on the client side. This approach provides a smooth experience similar to native apps.


## Backend


1. Do we need to re-create json for each car ?
2. How can we do minimum amount of work to return the response ?


To keep in mind; 
- Every day car prices changes automatically.
- Operation team can make new car live anytime
- To render full car data - it uses ~10 tables from normalised schema
- All changes to db can be done through different portals.
  - Operation portal built using cakephp app - perform operations
  - Inventory App - that talks to different django application
  - Data Science python scripts to update prices in bulk.

### Building Cache Layer

Use case
1. Filter car based on attributes
2. Cache car information

#### Dedicated Page
- Fetch from redis and return
- Cache Miss, fill cache and return

```python
import redis
dedicated_key = "dp:{car_id}"

class DedicatedPageView(generic.ListRetrieveView):
    def get(request: Request, id: int, **kwargs):
      con = redis.get_connection()
      key = dedicated_key.format(car_id=id)
      value = con.get(rkey)
      if not value:
        # cache miss
        car_obj = Car.objects.get(id=id)
        data = DedicatedSerialiser(obj=car_obj).data
        con.set(key, data, ttl=one_day_in_seconds)
        return data
     return value 
# Find the thundering herd aka cache stampede here, # comment with your solution!
```
Are we done ? No

> There are only two hard things in Computer Science: cache invalidation and naming things.
-- [Phil Karlton](https://martinfowler.com/bliki/TwoHardThings.html)


#### Cache Invalidation 

In MySQL, you can listen to binlog [[1]](#WAL) and get notified about all changes to the table - DDL & DML
 
- Data defiantion language 
  - CREATE | ALTER | DROP TABLE
- Data modification language
  - INSERT | UPDATE | DELETE | REPLACE FROM TABLE 

Using [python library](https://github.com/pratikgajjar/mysql-data-stream-kafka) to hook into mysql change log, we emitted changes to kafka topic.

Topic - Log file where you can only append.

```
Topic Name:

  {database_name}.{table_name}

Messages:

   op: insert | delete | update

   before: json payload 
      with
        key = column name
        value = column value

   after: json payload
```

Using above logic we listen to all topics which would affect final payload generated for dedicated page. 

Now here we have 2 choices: 

1. Let user fill the cache.
2. Build the page data, fill the cache.

Since we know there could be only 10_000 active cars, we can go ahead with 2nd option as memory usage won't be very high. 

Let's say dedicated page payload size was 20KB - for 10_000 cars, we would use only 2 000 000 KB, 2GB memory.

#### Listing Page

How would you implement filter in redis ? What about pagination, can we do that with filter without making DB call ? Stay tuned for part 2

DDL also means Dilwale Dulhaniya Le jaenge, IYKYK

---

#### [1] What is [the binary log](https://dev.mysql.com/doc/refman/8.0/en/binary-log.html) ? {#WAL}
The binary log contains “events” that describe database changes such as table creation operations or changes to table data. It also contains events for statements that potentially could have made changes (for example, a DELETE which matched no rows), unless row-based logging is used. The binary log also contains information about how long each statement took that updated data.

In PostgresSQL [WAL](https://www.postgresql.org/docs/current/wal-intro.html) 

Write-Ahead Logging (WAL) is a standard method for ensuring data integrity. A detailed description can be found in most (if not all) books about transaction processing. Briefly, WAL's central concept is that changes to data files (where tables and indexes reside) must be written only after those changes have been logged, that is, after WAL records describing the changes have been flushed to permanent storage. If we follow this procedure, we do not need to flush data pages to disk on every transaction commit, because we know that in the event of a crash we will be able to recover the database using the log: any changes that have not been applied to the data pages can be redone from the WAL records. (This is roll-forward recovery, also known as REDO.)

Similarly most database platforms provide a way to read database changes.

Data Engineers would be familiar with term - CDC - [Change data capture](https://www.confluent.io/learn/change-data-capture/)

Change data capture (CDC) refers to the tracking of all changes in a data source (databases, data warehouses, etc.) so they can be captured in destination systems. In short, CDC allows organizations to achieve data integrity and consistency across all systems and deployment environments.

