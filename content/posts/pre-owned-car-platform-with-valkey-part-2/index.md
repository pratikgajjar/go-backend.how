+++
title = "🏎️ Building pre-owned Car Platform With Valkey - Part 2"
description = "In Part 2, we will focus on building and optimizing the listing page using Valkey. We will explore how to handle complex filters, manage pagination efficiently, and ensure the listing page loads quickly to provide an excellent user experience."
date = 2024-07-17T19:54:52+05:30
lastmod = 2024-07-17T19:54:52+05:30
publishDate = "2024-07-17T19:54:52+05:30"
draft = false
tags = ['django', 'redis', 'drf', 'cdc', 'valkey']
series = ['valkey-car-platform']
images = ["og-71f711d1.png"]
featured = false
hnItemId = 41282624
theme = "coral"
+++

{{< viz kind="hero" frame="none" fallback="hero.svg" alt="A listing request's four filters drawn as rows of car ids; the cars filled in every row are the page, served from Valkey while the SQL database stays off the read path" caption="Sample data: 12 cars. Each filter you switch on is one sorted set in Valkey, one row here. A car is on the page when its column is full in every row." >}}

In [Part 1](/posts/building-blazingly-fast-pre-owned-car-platform-with-valkey-part-1) of our series, we explored the foundational aspects of our platform's performance optimization. We began by defining our business model, which combines a marketplace and inventory system to facilitate car sales. We detailed the user flow, including how users view ads, generate leads, and book test drives. Our primary focus was on enhancing the performance of _individual car pages_, where we discussed various strategies to reduce latency and improve load times. We examined the impact of client-side versus server-side rendering and outlined initial approaches to optimizing both frontend and backend components.

In Part 2, we will focus on building and optimizing the listing page using Valkey. We will explore how to handle complex filters, manage pagination efficiently, and ensure the listing page loads quickly to provide an excellent user experience.

We will review the existing design and discuss how we mapped our business use cases to Valkey to significantly reduce response times. This will include an exploration of how to handle complex filters, manage pagination effectively, and leverage Valkey's capabilities to ensure that the listing page delivers a fast and seamless user experience.

# What ?

The listing page is where users first interact with our inventory. It displays a comprehensive list of cars with basic information and provides filters and ordering options to help users refine their search effectively. Our goal is to ensure this page loads quickly and efficiently, as it plays a crucial role in reducing bounce rates.

# Why ?

As we discovered in Part 1, approximately 40-60% of user interactions begin with the listing page. Therefore, optimizing its performance can significantly improve the overall user experience, increase engagement, and ultimately drive more sales.

# Specification

To meet our users' needs, we've identified three key features for the listing page:

**Filters**: Allow users to narrow down their search by applying various filters such as make, model, year, price range, mileage, etc.

**Pagination**: Divide the extensive list of cars into manageable pages to improve load times and user experience.

**Recommendation Model**: Use a recommendation engine to order the cars based on user's browsing history or preferences.

# Filters

In a typical e-commerce site, filters help narrow down the vast inventory by applying complex queries behind the scene. Let's see how we can handle this using SQL Database.

## Database

### Schema

Car

| id  | price  | varient_id | color_id | date_created     |
| --- | ------ | ---------- | -------- | ---------------- |
| 1   | 775000 | 123        | 1        | 2020-07-20 02:17 |

Varient

| id  | model_id | name | date_created     |
| --- | -------- | ---- | ---------------- |
| 123 | 100      | XM   | 2020-07-20 02:17 |

Model

| id  | make_id | name  | date_created     |
| --- | ------- | ----- | ---------------- |
| 100 | 10      | Nexon | 2020-07-20 02:17 |

Make

| id  | name | date_created     |
| --- | ---- | ---------------- |
| 10  | Tata | 2020-07-20 02:17 |

Features

| id  | name | date_created     |
| --- | ---- | ---------------- |
| 20  | AMT  | 2020-07-20 02:17 |

CarFeatures

| id  | car_id | feature_id |
| --- | ------ | ---------- |
| 1   | 1      | 20         |

To simplify and address sufficient edge cases, we've explored a partial schema.

### Backend

In the backend, we are using [Django](https://www.djangoproject.com/) and [Django REST Framework](https://www.django-rest-framework.org/) to create REST APIs, alongside the [django-filter](https://django-filter.readthedocs.io/en/stable/guide/usage.html) library to easily add complex filters.

```py
from django_filters import rest_framework as filters

class NumberInFilter(filters.BaseInFilter, filters.NumberFilter):
    """Accepts a comma-separated list, e.g. make=10,12"""

class CarFilterSet(filters.FilterSet):
    """Custom filter class for filtering cars"""
    city_id = NumberInFilter(field_name="locality__city__id", lookup_expr="in")
    price_min = filters.NumberFilter(field_name="price", lookup_expr="gte")
    price_max = filters.NumberFilter(field_name="price", lookup_expr="lte")
    make = NumberInFilter(field_name="varient__model__make__id", lookup_expr="in")
    model = NumberInFilter(field_name="varient__model__id", lookup_expr="in")
    color = NumberInFilter(field_name="color__id", lookup_expr="in")
    features = NumberInFilter(field_name="features__id", lookup_expr="in")
    slug = SlugFilter()  # our own filter, described below

    class Meta:
        model = Car
        fields = [
            "make",
            "model",
            "year",
            "color",
            "price",
            "slug"
        ]
```

With Django REST Framework ViewSets, each request runs three steps:

1. **Filtering**: We define filters in our serializers or viewsets, which Django Rest Framework applies to our queryset. This means only the relevant objects that match the filtering criteria are considered for further processing.

2. **Pagination**: If pagination is enabled (which it usually is), Django Rest Framework splits up the filtered queryset into smaller, paginated chunks. This helps manage large datasets and improves performance by reducing the amount of data processed at once.

3. **Serialization**: Once we have our paginated queryset, Django Rest Framework serializes these objects into JSON format. In other words, it converts our Django models or querysets into a JSON response that can be easily sent back to the client (your frontend or API consumer).

So, each time you send a request to one of your API endpoints using ViewSets, this series of operations happens behind the scenes: filtering based on defined criteria, paginating the results for efficiency, and then converting those results into JSON format for transmission.

```py
from rest_framework import viewsets, mixins
from rest_framework.filters import OrderingFilter
from django_filters.rest_framework import DjangoFilterBackend
from .filters import CarFilterSet

class CarViewSet(viewsets.GenericViewSet, mixins.ListModelMixin):
    """
    A viewset that provides the standard actions for the User model,
    including filtering using CarFilterSet.
    """
    queryset = Car.objects.all() # django lazy queryset
    serializer_class = CarSerializer # converts django orm objects into json
    filter_backends = (DjangoFilterBackend, OrderingFilter) # django filters
    filterset_class = CarFilterSet # custom filterset
    ordering_fields = ["price", "year"]
    pagination_class = CarPagination

```

### Request

```sql
GET https://api.car.com/listing/?city_id=1&price_min=200000&price_max=400000&make=120,121&ordering=price&page=2

SELECT car.id, car.price, car.varient_id, car.color_id, car.locality_id
  FROM car
 INNER JOIN locality ON (car.locality_id = locality.id)
 INNER JOIN varient ON (car.varient_id = varient.id)
 INNER JOIN model ON (varient.model_id = model.id)
 WHERE (locality.city_id IN (1) AND car.price >= 200000 AND car.price <= 400000
        AND model.make_id IN (120, 121))
 ORDER BY car.price ASC
 LIMIT 10   -- page_size
OFFSET 10   -- (page - 1) * page_size; max_page = ceil(count / page_size)
```

This is the SQL Django generates for the filter set above. It joins only the tables a filter needs: `city_id` is already a column on `locality`, and `make_id` a column on `model`, so `city` and `make` are never joined. Pagination runs a second query, `COUNT(*)` with the same joins, and the serializer then reads `model_name`, `varient_name` and `city_name`, which costs more joins with `select_related`, or one query per car without it. All of this runs on every request.

{{< viz kind="sql-joins" fig="1" title="What each filter joins" frame="none" fallback="sql-joins.svg" alt="The car schema as a graph of tables; switching filters on shows which tables Django joins and the SQL it generates" caption="SQL from Django 6.1 and django-filter 26.1 with this post's filter set (SQLite backend, quotes removed). `features` joins the through table, so a car with two of the requested features comes back twice until you add `.distinct()`." >}}

### Response

```json
HTTP 200 OK
{
  "count": 1023,
  "next": "https://api.car.com/listing/?page=3",
  "previous": "https://api.car.com/listing/?page=1",
  "results": [
    {
      "id": 1,
      "images": [
        "https://cdn.car.com/1/front.webp",
        "https://cdn.car.com/1/left.webp",
        "https://cdn.car.com/1/right.webp",
        "https://cdn.car.com/1/back.webp"
      ],
      "price": 721000,
      "model_name": "Nexon",
      "varient_name": "XM",
      "link": "/user-cars/1",
      "city_name": "Mumbai",
      "owner": "1st"
    }
    . . . = page_size cars
  ]
}
```

To improve SEO performance, we've incorporated dynamic slugs into our URLs, rendering them more intuitive and user-friendly. When a user searches Google for "Used Nexon car," our indexed page's URL now mirrors this exact search query, boosting our visibility in those specific results and aligning our content with the user's intent – ultimately drawing in more relevant traffic.

```sql
🌐 https://car.com/used-nexon-cars-in-mumbai
-- client takes path and sends as slug query param to the backend
GET https://api.car.com/listing/?slug=used-nexon-cars-in-mumbai
```

In this case, the `SlugFilter` will parse the tokens from the URL and use a database table to return the appropriate query string. For any given `SlugFilter`, a valid query string combination will always exist as it is a subset of the overall filters.

```md
used-nexon-cars-in-mumbai => model=121&city=1
```

| id  | value  | type      | filter |
| --- | ------ | --------- | ------ |
| 1   | nexon  | model     | 121    |
| 2   | mumbai | city      | 1      |
| 3   | 4-lakh | price     | 400000 |
| 4   | tata   | make      | 2      |
| 5   | petrol | fuel_type | 1      |

## ValKey

We'll discuss how to efficiently store and retrieve car data in-memory, aiming to minimize round trips to ValKey[^1] while optimizing space usage.

### Why Use a Hash?

To serve the car details shown in list responses, we keep one hash, `car:`, with the car id as the field and the listing JSON as the value.

**One round trip per page:** `HMGET car: 101 102 103` returns the JSON for every car on a page in one call. With a maximum page size of 35, that is at most 35 values per `HMGET`. (`MGET` over one string key per car would also be one call.)

**Memory:** A hash uses the compact listpack encoding only while it has at most 512 fields (`hash-max-listpack-entries`) and every value is at most 64 bytes (`hash-max-listpack-value`)[^5]. Our `car:` hash holds every live car, and each value is a JSON document longer than 64 bytes, so Valkey stores it as a regular hash table. In a test on Valkey 9.1 with 10,000 sample cars, the hash used about 5% less memory than one string key per car. The large savings Instagram describes come from many small hashes with short values:

> the Redis setting ‘hash-zipmap-max-entries’ configures the maximum number of entries a hash can have while still being encoded efficiently. - [Instagram Blog](https://instagram-engineering.com/storing-hundreds-of-millions-of-simple-key-value-pairs-in-redis-1091ae80f74c)

That setting is now called `hash-max-listpack-entries`.

{{< viz kind="keys" key="hash" title="The car: hash" frame="none" wide="false" fallback="keys.svg" alt="The car: hash maps car ids to listing JSON; HMGET returns one value per id and nil for a missing id" caption="Sample values. Encodings and replies from Valkey 9.1." >}}

#### Data Consistency and Invalidation

To maintain data consistency, we listen to the database change log. Whenever a detail in the response payload changes, we update that car's field in the `car:` hash. When a car reaches a terminal state (e.g., sold or removed), we delete its field from the hash and its id from the index sets. Cached results (below) still hold that id until their TTL ends, so `HMGET` returns nil for it and the view must skip it.

### Why Use a Sorted Set?

Sorted sets offer efficient data retrieval and filtering in ValKey, making them particularly useful for tasks like pagination and attribute-based searches. Here's why:

#### Efficient Filtering with Set Theory

While we could use sorting (`SORT` command)[^2] on lists or sets to retrieve elements, it's an expensive operation with a time complexity of O(N+M\*log(M)), where:

- N is the number of elements in the list/set to sort
- M is the number of returned elements

Sorted sets allow us to efficiently filter and retrieve data based on attributes using set theory[^4] operations:

- Retrieve cars with prices between 100K INR and 500K INR:

  ```txt
  ZRANGEBYSCORE car:price 100000 500000
  ```

- Fetch cars with color_id = 5:

  ```txt
  ZRANGEBYSCORE car:color 5 5
  ```

These operations have a time complexity of O(log(N)+M), making them more efficient than sorting lists/sets. Here, N is the number of elements in the sorted set, and M is the number of returned elements.

#### Optimized Pagination with Caching

When the sort order depends on attributes like price or date_added, we store the filtered, sorted result and use it for every page of that query:

1. Store the result in a sorted set with a key like `page:price:{queryhash}` (where `{queryhash}` identifies the filters) and a TTL.
2. Read one page with `ZRANGE key start stop` (`ZREVRANGE` for descending order), then fetch those cars with `HMGET` from the `car:` hash.
3. Use `ZCARD` for the total number of cars in the result.

Later pages of the same query skip the filters. The order depends only on car data, so it is the same for every user who sends that query.

{{< viz kind="keys" key="zset" title="The car:price index" frame="none" wide="false" fallback="keys.svg" alt="The car:price sorted set maps car ids to prices; ZRANGEBYSCORE returns the cars in a price range" caption="Sample values. Encodings and replies from Valkey 9.1." >}}

### Why Use Unordered Sets ?

When the order comes from personalised recommendations, it depends on the buyer, and it changes every 45 minutes when we retrain our recommendation model. So we do not store the order:

**Query hash from car filters only**: we hash only the car-related filters. This pays off most on popular base pages, such as all cars in Mumbai.

**Unordered set of car ids**: we store only the ids that match, with `SADD`. The web server ranks them on each request with the LightFM model it keeps in memory.

A stored order would have to exist once per buyer (or buyer group) and be rewritten after every retrain. The set is one key per query, and a retrain writes nothing to Valkey. The cost moves to the web server, which scores every id in the set on each request.

{{< viz kind="reco-order" fig="2" frame="none" title="One set, ranked per buyer" fallback="reco-order.svg" alt="One unordered set of nine car ids in Valkey, ranked differently for two buyers and two model versions by LightFM in the web server" caption="Sample scores. The set in Valkey is the same for both buyers and both model versions; only the order in the web server changes. At one retrain every 45 minutes, a day has 32 retrains." >}}

### Cache-Hit

1. Retrieve precomputed filtered car IDs from ValKey using the query string hash as the key.
2. Provide the fetched car IDs to our recommendation engine for further processing.
3. Paginate results at the application level using list comprehension to reduce data transfer and improve performance.
4. Fetch additional car details using `HMGET`, retrieving multiple hash fields efficiently.

### Cache-Miss

If the filtered car set is not cached in ValKey following query string hash calculation, perform the following steps:

1. Calculate the query string hash.
   - The hash must not depend on filter order (e.g., `F('city_id=1&color=3,4') eq F('color=4,3&city_id=1')`).
2. Build the target car set with set operations:

   - Intersect sets with `ZINTERSTORE` to combine filters:

     ```txt
     ZINTERSTORE filtered_cars 2 cars_set_1 cars_set_2 WEIGHTS 1 0
     ```

     By default, `ZINTERSTORE` adds up a car's scores from every input set. Give weight 1 only to the set whose score is the sort key, such as `car:price`, so the result keeps the price as its score.

   - Combine sets with `ZUNIONSTORE`, for example for `make=10,12`:

     ```txt
     ZUNIONSTORE all_cars 3 cars_set_1 cars_set_2 cars_set_3 AGGREGATE MAX
     ```

3. Fetch car IDs in the required order using `ZRANGE` or `ZRANGEBYSCORE`.

In some cases, we perform set operations in the web server to compute the resulting list of cars before fetching details with `HMGET`.

```py
def filter_by_price(redis_pipe, price_min='-inf', price_max='+inf'):
    return redis_pipe.zrangebyscore(
        name="car:price",
        min=price_min,
        max=price_max
    )
```

#### Dealing with many-to-many relationship

In case you have noticed we have Features table with MxN relationship with Cars table via CarFeatures. As one car can have many features and one feature could be there with multiple cars. How are we filtering here ?

In such cases, instead of going with `car:color` sorted set, we keep sorted set of each feature, `car:feature:{id} -> {car_id} -> 1`

Now we can use intersection and union on these sets to compute the filter.

#### Reducing network round trips

Valkey pipelining[^3] sends several commands without waiting for each reply. It saves network round trips, and it saves server work too: Valkey reads many commands with one `read()` system call and writes many replies with one `write()`. The Valkey docs report up to 10 times more queries per second with long pipelines.

On a cache miss, we send the set operations in one pipeline.

### One request, end to end

The figure follows one filtered listing request over 12 sample cars: a miss, a hit for page 2, and what a sale does to a stored result.

{{< viz kind="listing-request" fig="3" frame="none" title="One listing request through Valkey" fallback="listing-request.svg" alt="A listing request is turned into a canonical key; on a miss, four index sets are intersected and stored with a TTL; page 2 is a hit; a sold car leaves a stale id in the stored result" caption="Sample data. The commands are one way to build the result on the server; every reply shown came from running them on Valkey 9.1 with this data. The key is `sha1` of the canonical query, first 18 hex digits. Use ← and → to step." >}}

# Result

Production numbers from NewRelic, before and after the change.

## Before and after Optimization

{{< figure src="listing-viewset-list.png" title="List API: 4x faster" alt="NewRelic stats" width="auto" caption="Listing page 4x faster" >}}
{{< figure src="listing-viewset-retrieve.png" title="Retrieve API: 4.7x faster" alt="NewRelic stats" width="auto" caption="Dedicated page 4.7x faster" >}}
{{< figure src="overall-stats.png" title="Bottleneck moved from database to Python" alt="NewRelic stats" width="auto" caption="Bottleneck moved from database to python" >}}

## Wrk Benchmark

{{< figure src="wrk-bench-diff.png" title="List API" alt="Wrk benchmark" width="auto" caption="We can serve 6x more requests" >}}

Working on performance optimization often requires a deep dive into the execution of programs, leading to a more profound understanding of their inner workings. This was a key focus in a project we undertook in 2021.

[^1]: {{< details "[Valkey](https://valkey.io/commands/) COMMAND Ref" >}}

| Command         | Description                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `SET`           | Sets the string value of a key, ignoring its type. The key is created if it doesn't exist.              |
| `TTL`           | Returns the expiration time in seconds of a key.                                                        |
| `HMSET`         | Sets the values of multiple fields.                                                                     |
| `HMGET`         | Returns the values of the given fields in a hash.                                                       |
| `HGETALL`       | Returns all fields and values in a hash.                                                                |
| `SADD`          | Adds one or more members to a set. Creates the key if it doesn't exist.                                 |
| `SCARD`         | Returns the number of members in a set.                                                                 |
| `SINTER`        | Returns the intersection of multiple sets.                                                              |
| `SINTERSTORE`   | Stores the intersection of multiple sets in a key.                                                      |
| `SISMEMBER`     | Determines whether a member belongs to a set.                                                           |
| `SUNION`        | Returns the union of multiple sets.                                                                     |
| `SUNIONSTORE`   | Stores the union of multiple sets in a key.                                                             |
| `ZADD`          | Adds one or more members to a sorted set, or updates their scores. Creates the key if it doesn't exist. |
| `ZCARD`         | Returns the number of members in a sorted set.                                                          |
| `ZCOUNT`        | Returns the count of members in a sorted set that have scores within a range.                           |
| `ZDIFFSTORE`    | Stores the difference of multiple sorted sets in a key.                                                 |
| `ZINTERSTORE`   | Stores the intersection of multiple sorted sets in a key.                                               |
| `ZMSCORE`       | Returns the score of one or more members in a sorted set.                                               |
| `ZRANGE`        | Returns members in a sorted set within a range of indexes.                                              |
| `ZRANGEBYSCORE` | Returns members in a sorted set within a range of scores.                                               |
| `ZRANGESTORE`   | Stores a range of members from a sorted set in a key.                                                   |
| `ZRANK`         | Returns the index of a member in a sorted set ordered by ascending scores.                              |
| `ZREM`          | Removes one or more members from a sorted set. Deletes the sorted set if all members were removed.      |
| `ZSCAN`         | Iterates over members and scores of a sorted set.                                                       |
| `ZSCORE`        | Returns the score of a member in a sorted set.                                                          |
| `ZUNION`        | Returns the union of multiple sorted sets.                                                              |
| `ZUNIONSTORE`   | Stores the union of multiple sorted sets in a key.                                                      |

{{</details>}}

[^2]: <https://valkey.io/commands/sort/>

[^3]: <https://valkey.io/topics/pipelining/>

[^4]: <https://en.wikipedia.org/wiki/Set_theory>

[^5]: <https://valkey.io/topics/memory-optimization/>
