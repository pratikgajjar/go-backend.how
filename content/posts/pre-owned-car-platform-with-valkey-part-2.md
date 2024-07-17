+++
title = "🏎️ Pre Owned Car Platform With Valkey Part 2"
description = ""
date = 2024-07-17T19:54:52+05:30
lastmod = 2024-07-17T19:54:52+05:30
publishDate = "2024-07-17T19:54:52+05:30"
draft = true
tags = []
images = []
+++

This post is 2nd part of serries building blazing fast pre owned car platform using Valkey. Checkout the [part-1](/posts/building-blazingly-fast-pre-owned-car-platform-with-valkey-part-1) if haven't already.

# What ?

We have list of cars that needs to be shown, it may include filters.

# Why ?

In performance marketing, we have ad link will lead to list of cars. To maximise leads, we need to reduce bounce rate
that correlated with page loading time.

# Specification

- Filters
- Pagination
- Recommendation order

# Filters

## Database

First, lets go through how it works with db, using django-filter with django-rest-framework we have defined filterclass that handles query parsing and database filters.

```py
from django_filters import rest_framework as filters

class CarFilterSet(filters.FilterSet):
    """Custom filter class for filtering user, you can add different filter attributes later"""
    city_id = filter.TraversalFilter(name="locality__city__id", field_name="city_id", lookup_expr="in")
    price_min = django_filters.NumberFilter(name='price', lookup_expr='gte')
    price_max = django_filters.NumberFilter(name='price', lookup_expr='lte')
    make = django_filters.NumberFilter(name="varient__model__make__id", lookup_expr="in")
    model = django_filters.NumberFilter(name="varient__model__id", lookup_expr="in")
    color = django_filter.NumberFilter(name="color__id", lookup_expr="in")
    slug = filter.SlugFilter()

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
# NOTE: Not exact syntax
```

In django-rest-framework

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
```

Example request

```sql
GET https://api.car.com/listing/?city_id=1&price_min=200000&price_max=400000&make_id=121

SELECT ... FROM car
    LEFT JOIN locality on car.locality_id = locality.id
    LEFT JOIN city on locality.city_id = city.id
    LEFT JOIN varient on car.varient_id = varient.id
    LEFT JOIN model on varient.model_id = model.id
    LEFT JOIN make on model.make_id = make.id
  WHERE
    city.id = 1
    AND car.price > 200000
    AND car.price < 400000
    AND make.id = 121
```

To improve SEO, we supported multiple types of slug varient that are more human friendly.
So when someone searches on google used nexon car, we would already have indexed page which includes `used-nexon-cars-in-mumbai` path
that improves the ranking

```sql
GET https://api.car.com/listing/?slug=used-nexon-cars-in-mumbai
```

In this case `SlugFilter` will parse the text and creates `id` filters, due to dynamic nature of data this is stored in the database
